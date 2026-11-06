use tauri::Emitter;
use tauri::{AppHandle, Manager, Position, Size};
use tauri_nspanel::{
    CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel,
};

#[derive(Clone, Copy, Default, serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWidgetState {
    pub pinned: bool,
    pub click_through: bool,
}

// Never persist click-through mode: every launch has a reachable interactive panel.
static DESKTOP_MODE: std::sync::Mutex<DesktopWidgetState> =
    std::sync::Mutex::new(DesktopWidgetState { pinned: false, click_through: false });

fn requested_mode(pinned: bool, click_through: bool) -> Result<DesktopWidgetState, String> {
    if click_through && !pinned {
        return Err("請先釘選桌面，再啟用滑鼠穿透".into());
    }
    Ok(DesktopWidgetState { pinned, click_through })
}

pub fn desktop_widget_state() -> DesktopWidgetState {
    *DESKTOP_MODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn get_desktop_widget_state() -> DesktopWidgetState {
    desktop_widget_state()
}

fn apply_desktop_mode(app_handle: &AppHandle, mode: DesktopWidgetState) -> Result<DesktopWidgetState, String> {
    // This function only runs on AppKit's main thread.
    if objc2_foundation::MainThreadMarker::new().is_none() {
        return Err("無法在目前執行緒調整桌面浮窗".into());
    }
    init(app_handle).map_err(|_| "無法準備桌面浮窗".to_string())?;
    let panel = app_handle.get_webview_panel("main").map_err(|_| "無法取得桌面浮窗".to_string())?;
    *DESKTOP_MODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
    panel.set_hides_on_deactivate(false);
    panel.set_movable_by_window_background(mode.pinned);
    panel.set_ignores_mouse_events(mode.click_through);
    panel.set_level(if mode.pinned { PanelLevel::Floating.value() } else { PanelLevel::MainMenu.value() + 1 });
    if mode.click_through {
        panel.order_front_regardless();
    } else {
        panel.show_and_make_key();
    }
    let _ = app_handle.emit("widget:mode-changed", mode);
    let _ = app_handle.emit("tray:shown", ());
    Ok(mode)
}

pub fn set_desktop_mode(app_handle: &AppHandle, pinned: bool, click_through: bool) -> Result<DesktopWidgetState, String> {
    let mode = requested_mode(pinned, click_through)?;
    if objc2_foundation::MainThreadMarker::new().is_some() {
        return apply_desktop_mode(app_handle, mode);
    }
    let handle = app_handle.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    app_handle.run_on_main_thread(move || { let _ = sender.send(apply_desktop_mode(&handle, mode)); })
        .map_err(|_| "無法排定桌面浮窗操作".to_string())?;
    receiver.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "桌面浮窗尚未回應，請從選單列恢復互動".to_string())?
}

#[tauri::command]
pub async fn configure_desktop_widget(app_handle: AppHandle, pinned: bool, click_through: bool) -> Result<DesktopWidgetState, String> {
    set_desktop_mode(&app_handle, pinned, click_through)
}

fn monitor_contains_physical_point(
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
    point_x: f64,
    point_y: f64,
) -> bool {
    point_x >= origin_x
        && point_x < origin_x + width
        && point_y >= origin_y
        && point_y < origin_y + height
}

unsafe fn set_panel_frame_top_left(panel: &tauri_nspanel::NSPanel, x: f64, y: f64) {
    let point = tauri_nspanel::NSPoint::new(x, y);
    let _: () = objc2::msg_send![panel, setFrameTopLeftPoint: point];
}

fn set_panel_top_left_immediately(
    window: &tauri::WebviewWindow,
    app_handle: &AppHandle,
    panel_x: f64,
    panel_y: f64,
    primary_logical_h: f64,
) {
    let Ok(panel_handle) = app_handle.get_webview_panel("main") else {
        return;
    };

    let target_x = panel_x;
    let target_y = primary_logical_h - panel_y;

    if objc2_foundation::MainThreadMarker::new().is_some() {
        unsafe {
            set_panel_frame_top_left(panel_handle.as_panel(), target_x, target_y);
        }
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let panel_handle = panel_handle.clone();

    if let Err(error) = window.run_on_main_thread(move || {
        unsafe {
            set_panel_frame_top_left(panel_handle.as_panel(), target_x, target_y);
        }
        let _ = tx.send(());
    }) {
        log::warn!("Failed to position panel on main thread: {}", error);
        return;
    }

    if rx.recv().is_err() {
        log::warn!("Failed waiting for panel position on main thread");
    }
}

/// Macro to get existing panel or initialize it if needed.
/// Returns Option<Panel> - Some if panel is available, None on error.
macro_rules! get_or_init_panel {
    ($app_handle:expr) => {
        match $app_handle.get_webview_panel("main") {
            Ok(panel) => Some(panel),
            Err(_) => {
                if let Err(err) = crate::panel::init($app_handle) {
                    log::error!("Failed to init panel: {}", err);
                    None
                } else {
                    match $app_handle.get_webview_panel("main") {
                        Ok(panel) => Some(panel),
                        Err(err) => {
                            log::error!("Panel missing after init: {:?}", err);
                            None
                        }
                    }
                }
            }
        }
    };
}

// Export macro for use in other modules
pub(crate) use get_or_init_panel;

/// Retrieve the tray icon rect and position the panel beneath it.
/// No-ops gracefully if the tray icon or its rect is unavailable.
pub(crate) fn position_panel_from_tray(app_handle: &AppHandle) {
    let Some(tray) = app_handle.tray_by_id("tray") else {
        log::debug!("position_panel_from_tray: tray icon not found");
        return;
    };
    match tray.rect() {
        Ok(Some(rect)) => {
            position_panel_at_tray_icon(app_handle, rect.position, rect.size);
        }
        Ok(None) => {
            log::debug!("position_panel_from_tray: tray rect not available yet");
        }
        Err(e) => {
            log::warn!("position_panel_from_tray: failed to get tray rect: {}", e);
        }
    }
}

/// Show the panel (initializing if needed), positioned under the tray icon.
pub fn show_panel(app_handle: &AppHandle) {
    let mode = desktop_widget_state();
    if mode.click_through {
        let _ = set_desktop_mode(app_handle, mode.pinned, false);
    }
    if let Some(panel) = get_or_init_panel!(app_handle) {
        panel.show_and_make_key();
        if !desktop_widget_state().pinned { position_panel_from_tray(app_handle); }
        let _ = app_handle.emit("tray:shown", ());
    }
}

/// Toggle panel visibility. If visible, hide it. If hidden, show it.
/// Used by global shortcut handler.
pub fn toggle_panel(app_handle: &AppHandle) {
    let mode = desktop_widget_state();
    if mode.click_through {
        let _ = set_desktop_mode(app_handle, mode.pinned, false);
        return;
    }
    let Some(panel) = get_or_init_panel!(app_handle) else {
        return;
    };

    if panel.is_visible() {
        log::debug!("toggle_panel: hiding panel");
        panel.hide();
    } else {
        log::debug!("toggle_panel: showing panel");
        panel.show_and_make_key();
        if !desktop_widget_state().pinned { position_panel_from_tray(app_handle); }
        let _ = app_handle.emit("tray:shown", ());
    }
}

// Define our panel class and event handler together
tauri_panel! {
    panel!(OpenUsagePanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel_event!(OpenUsagePanelEventHandler {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

pub fn init(app_handle: &tauri::AppHandle) -> tauri::Result<()> {
    if app_handle.get_webview_panel("main").is_ok() {
        return Ok(());
    }

    let window = app_handle.get_webview_window("main").unwrap();

    let panel = window.to_panel::<OpenUsagePanel>()?;

    // Disable native shadow - it causes gray border on transparent windows
    // Let CSS handle shadow via shadow-xl class
    panel.set_has_shadow(false);
    panel.set_opaque(false);
    panel.set_ignores_mouse_events(false);
    panel.set_hides_on_deactivate(false);
    panel.set_movable_by_window_background(false);

    // Configure panel behavior
    panel.set_level(PanelLevel::MainMenu.value() + 1);

    panel.set_collection_behavior(
        CollectionBehavior::new()
            .move_to_active_space()
            .full_screen_auxiliary()
            .value(),
    );

    panel.set_style_mask(StyleMask::empty().nonactivating_panel().value());

    // Set up event handler to hide panel when it loses focus
    let event_handler = OpenUsagePanelEventHandler::new();

    let handle = app_handle.clone();
    event_handler.window_did_resign_key(move |_notification| {
        if desktop_widget_state().pinned { return; }
        if let Ok(panel) = handle.get_webview_panel("main") {
            panel.hide();
        }
    });

    panel.set_event_handler(Some(event_handler.as_ref()));

    Ok(())
}

pub fn position_panel_at_tray_icon(
    app_handle: &tauri::AppHandle,
    icon_position: Position,
    icon_size: Size,
) {
    let window = app_handle.get_webview_window("main").unwrap();

    let (icon_phys_x, icon_phys_y) = match &icon_position {
        Position::Physical(pos) => (pos.x as f64, pos.y as f64),
        Position::Logical(pos) => (pos.x, pos.y),
    };
    let (icon_phys_w, icon_phys_h) = match &icon_size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width, s.height),
    };

    let monitors = window.available_monitors().expect("failed to get monitors");
    let primary_logical_h = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / m.scale_factor())
        .unwrap_or(0.0);

    let icon_center_x = icon_phys_x + (icon_phys_w / 2.0);
    let icon_center_y = icon_phys_y + (icon_phys_h / 2.0);

    let found_monitor = monitors.iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        monitor_contains_physical_point(
            origin.x as f64,
            origin.y as f64,
            size.width as f64,
            size.height as f64,
            icon_center_x,
            icon_center_y,
        )
    });

    let monitor = match found_monitor {
        Some(m) => m.clone(),
        None => {
            log::warn!(
                "No monitor found for tray rect center at ({:.0}, {:.0}), using primary",
                icon_center_x,
                icon_center_y
            );
            match window.primary_monitor() {
                Ok(Some(m)) => m,
                _ => return,
            }
        }
    };

    let target_scale = monitor.scale_factor();
    let mon_phys_x = monitor.position().x as f64;
    let mon_phys_y = monitor.position().y as f64;
    let mon_logical_x = mon_phys_x / target_scale;
    let mon_logical_y = mon_phys_y / target_scale;

    let icon_logical_x = mon_logical_x + (icon_phys_x - mon_phys_x) / target_scale;
    let icon_logical_y = mon_logical_y + (icon_phys_y - mon_phys_y) / target_scale;
    let icon_logical_w = icon_phys_w / target_scale;
    let icon_logical_h = icon_phys_h / target_scale;

    // Read panel width from the window, converted to logical points.
    // outer_size() returns physical pixels at the window's current scale factor.
    // If the window isn't available yet, parse the configured width from tauri.conf.json
    // (embedded at compile time) so it stays in sync automatically.
    let panel_width = match (window.outer_size(), window.scale_factor()) {
        (Ok(s), Ok(win_scale)) => s.width as f64 / win_scale,
        _ => {
            let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");
            conf["app"]["windows"][0]["width"]
                .as_f64()
                .expect("width must be set in tauri.conf.json")
        }
    };

    let icon_center_x = icon_logical_x + (icon_logical_w / 2.0);
    let monitor_width = monitor.size().width as f64 / target_scale;
    let panel_x = clamp_panel_x(icon_center_x, panel_width, mon_logical_x, monitor_width);
    let nudge_up: f64 = 6.0;
    // Clamp to the monitor's top edge: when the menu bar is set to auto-hide,
    // the tray rect sits above the visible screen, which would otherwise push
    // the panel's top edge off-screen and clip it.
    let panel_y = (icon_logical_y + icon_logical_h - nudge_up).max(mon_logical_y);

    set_panel_top_left_immediately(&window, app_handle, panel_x, panel_y, primary_logical_h);
}


fn clamp_panel_x(icon_center_x: f64, panel_width: f64, monitor_x: f64, monitor_width: f64) -> f64 {
    let right = (monitor_x + monitor_width - panel_width).max(monitor_x);
    (icon_center_x - panel_width / 2.0).clamp(monitor_x, right)
}

#[cfg(test)]
mod dashboard_tests {
    use super::{clamp_panel_x, requested_mode};

    #[test]
    fn desktop_mode_requires_pin_and_starts_interactive() {
        assert!(requested_mode(false, true).is_err());
        assert!(!requested_mode(false, false).unwrap().click_through);
        assert!(requested_mode(true, true).unwrap().click_through);
        assert_eq!(requested_mode(false, false).unwrap(), super::DesktopWidgetState::default());
    }

    #[test]
    fn wide_dashboard_stays_inside_both_monitor_edges() {
        assert_eq!(clamp_panel_x(20.0, 820.0, 0.0, 1440.0), 0.0);
        assert_eq!(clamp_panel_x(1420.0, 820.0, 0.0, 1440.0), 620.0);
        assert_eq!(clamp_panel_x(720.0, 820.0, 0.0, 1440.0), 310.0);
    }

    #[test]
    fn left_monitor_and_oversize_fallback_stay_visible() {
        assert_eq!(clamp_panel_x(-10.0, 820.0, -1440.0, 1440.0), -820.0);
        assert_eq!(clamp_panel_x(-1400.0, 820.0, -1440.0, 1440.0), -1440.0);
        assert_eq!(clamp_panel_x(300.0, 820.0, 0.0, 600.0), 0.0);
    }
}
