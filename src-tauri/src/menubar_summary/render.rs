//! Native theme rendering only; source selection remains in the parent module.
use super::*;

const COMPACT_FONT_PX: f64 = 34.0; // 17pt at the existing 2x backing scale.
#[derive(Debug, PartialEq)]
enum CompactPart<'a> { Icon(&'a str), Tag(&'a str), Percent(Option<u8>), Space(f64), Divider }
fn compact_parts(groups: &[SummaryGroup]) -> Vec<CompactPart<'_>> {
    use CompactPart::*;
    if groups.is_empty() { return vec![Tag("TU"), Space(6.0), Percent(None)]; }
    let mut parts = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        if index > 0 { parts.extend([Space(10.0), Divider, Space(10.0)]); }
        parts.extend([Icon(&group.id), Space(4.0)]);
        for (index, row) in group.rows.iter().enumerate() {
            if index > 0 { parts.push(Space(8.0)); }
            if group.id == "antigravity" {
                parts.extend([Icon(if row.key == "gemini" { "gemini" } else { "claude" }), Space(3.0)]);
            } else if row.key == "session" || row.key == "weekly" {
                parts.extend([Tag(row_tag(row)), Space(2.0)]);
            }
            parts.push(Percent(row.remaining_percent));
        }
    }
    parts
}
fn percent_text(percent: Option<u8>) -> String {
    percent.map(|value| format!("{value}%")).unwrap_or_else(|| "--".into())
}
fn tooltip(groups: &[SummaryGroup], style: SummaryStyle) -> String {
    if groups.is_empty() { return "TokenUsageWidget · 尚未啟用服務".into(); }
    groups.iter().flat_map(|group| group.rows.iter().map(move |row| {
        if style == SummaryStyle::Compact {
            format!("{} · {} 剩餘 {}", if group.id == "antigravity" { "Antigravity" } else { &group.name }, row.label, percent_text(row.remaining_percent))
        } else { format!("{} {}", group.name, row_text(row)) }
    })).collect::<Vec<_>>().join("\n")
}

fn icon_bytes(id: &str) -> Option<&'static [u8]> {
    macro_rules! icon { ($name:literal) => { Some(include_bytes!(concat!("../../icons/menubar/", $name, ".png")).as_slice()) }; }
    match id {
        "claude" => icon!("claude"), "codex" => icon!("codex"), "gemini" => icon!("gemini"),
        "antigravity" => icon!("antigravity"), "cursor" => icon!("cursor"),
        "amp" => icon!("amp"), "copilot" => icon!("copilot"), "grok" => icon!("grok"),
        "devin" => icon!("devin"), "factory" => icon!("factory"), "jetbrains-ai-assistant" => icon!("jetbrains-ai-assistant"),
        "kimi" => icon!("kimi"), "minimax" => icon!("minimax"), "kiro" => icon!("kiro"),
        "perplexity" => icon!("perplexity"), "synthetic" => icon!("synthetic"), "zai" => icon!("zai"),
        "opencode-go" => icon!("opencode-go"), "mock" => icon!("mock"), _ => None,
    }
}

pub(super) fn render_bitmap(groups: &[SummaryGroup], style: SummaryStyle) -> Result<(objc2::rc::Retained<objc2_app_kit::NSBitmapImageRep>, objc2_foundation::NSSize), String> {
    if style == SummaryStyle::Compact { render_compact_bitmap(groups) } else { render_quota_bitmap(groups) }
}

fn render_compact_bitmap(groups: &[SummaryGroup]) -> Result<(objc2::rc::Retained<objc2_app_kit::NSBitmapImageRep>, objc2_foundation::NSSize), String> {
    use objc2::{AnyThread, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSGraphicsContext, NSImage, NSStringDrawing, NSCompositingOperation};
    use objc2_foundation::{NSData, NSDictionary, NSPoint, NSRect, NSSize, NSString};
    let font = NSFont::monospacedDigitSystemFontOfSize_weight(COMPACT_FONT_PX, 0.3);
    let label_font = NSFont::monospacedSystemFontOfSize_weight(16.0, 0.3);
    let black = NSColor::blackColor();
    let attrs = unsafe { NSDictionary::<NSString, AnyObject>::from_slices(
        &[NSFontAttributeName, NSForegroundColorAttributeName], &[font.as_ref(), black.as_ref()]) };
    let small_attrs = unsafe { NSDictionary::<NSString, AnyObject>::from_slices(
        &[NSFontAttributeName, NSForegroundColorAttributeName], &[label_font.as_ref(), black.as_ref()]) };
    let parts = compact_parts(groups);
    let text = |part: &CompactPart| match part {
        CompactPart::Tag(value) => Some(NSString::from_str(value)),
        CompactPart::Percent(value) => Some(NSString::from_str(&percent_text(*value))), _ => None,
    };
    let widths: Vec<f64> = parts.iter().map(|part| match part {
        CompactPart::Icon(_) => 36.0, CompactPart::Space(width) => *width, CompactPart::Divider => 1.0,
        _ => unsafe { text(part).unwrap().sizeWithAttributes(Some(if matches!(part, CompactPart::Tag(_)) { &small_attrs } else { &attrs })).width.ceil() },
    }).collect();
    let width = widths.iter().sum::<f64>() + 8.0;
    // Decode every embedded icon before changing graphics state, so failures
    // cannot leave the caller's AppKit drawing context installed.
    let icons = parts.iter().map(|part| match part {
        CompactPart::Icon(id) => icon_bytes(id).and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))).map(Some).ok_or_else(|| PAINT_ERROR.to_string()),
        _ => Ok(None),
    }).collect::<Result<Vec<_>, _>>()?;
    let rep = unsafe { NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
        NSBitmapImageRep::alloc(), std::ptr::null_mut(), width.ceil() as isize, 44, 8, 4, true, false, NSDeviceRGBColorSpace, 0, 0)
    }.ok_or_else(|| PAINT_ERROR.to_string())?;
    let data = rep.bitmapData();
    if data.is_null() { return Err(PAINT_ERROR.into()); }
    unsafe { std::ptr::write_bytes(data, 0, rep.bytesPerRow() as usize * 44); }
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).ok_or_else(|| PAINT_ERROR.to_string())?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    let mut x = 4.0;
    for ((part, width), icon) in parts.iter().zip(widths).zip(icons) {
        match part {
            CompactPart::Icon(_) => {
                let image = icon.unwrap();
                image.drawInRect_fromRect_operation_fraction(NSRect::new(NSPoint::new(x, 4.0), NSSize::new(36.0, 36.0)), NSRect::new(NSPoint::new(0.0, 0.0), image.size()), NSCompositingOperation::SourceOver, 1.0);
            }
            CompactPart::Space(_) => {}
            CompactPart::Divider => { NSColor::colorWithWhite_alpha(0.0, 0.25).setFill(); unsafe { objc2_app_kit::NSRectFill(NSRect::new(NSPoint::new(x, 10.0), NSSize::new(1.0, 24.0))) }; }
            _ => unsafe { text(part).unwrap().drawAtPoint_withAttributes(NSPoint::new(x, if matches!(part, CompactPart::Tag(_)) { 12.0 } else { 1.0 }), Some(if matches!(part, CompactPart::Tag(_)) { &small_attrs } else { &attrs })); },
        }
        x += width;
    }
    NSGraphicsContext::restoreGraphicsState_class();
    let logical = NSSize::new(width / 2.0, 22.0);
    rep.setSize(logical);
    Ok((rep, logical))
}

fn render_quota_bitmap(groups: &[SummaryGroup]) -> Result<(objc2::rc::Retained<objc2_app_kit::NSBitmapImageRep>, objc2_foundation::NSSize), String> {
    use objc2::{AnyThread, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSGraphicsContext, NSStringDrawing};
    use objc2_foundation::{NSDictionary, NSPoint, NSSize, NSString};
    let font = NSFont::monospacedSystemFontOfSize_weight(18.0, 0.0);
    let black = NSColor::blackColor();
    let attrs = unsafe { NSDictionary::<NSString, AnyObject>::from_slices(
        &[NSFontAttributeName, NSForegroundColorAttributeName], &[font.as_ref(), black.as_ref()]) };
    let mut columns = Vec::new();
    let mut width: f64 = 8.0;
    for text in columns_text(groups) {
        let rows = text.map(|text| NSString::from_str(&text));
        let column_width = rows.iter().map(|text| unsafe { text.sizeWithAttributes(Some(&attrs)).width }).fold(0.0, f64::max).ceil() + 16.0;
        columns.push((rows, column_width));
        width += column_width;
    }
    let pixels = width.ceil() as isize;
    let rep = unsafe { NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
        NSBitmapImageRep::alloc(), std::ptr::null_mut(), pixels, 44, 8, 4, true, false, NSDeviceRGBColorSpace, 0, 0)
    }.ok_or_else(|| PAINT_ERROR.to_string())?;
    let data = rep.bitmapData();
    if data.is_null() { return Err(PAINT_ERROR.into()); }
    unsafe { std::ptr::write_bytes(data, 0, rep.bytesPerRow() as usize * 44); }
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).ok_or_else(|| PAINT_ERROR.to_string())?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    let mut x = 4.0;
    for (rows, column_width) in columns {
        unsafe {
            rows[0].drawAtPoint_withAttributes(NSPoint::new(x, 22.0), Some(&attrs));
            rows[1].drawAtPoint_withAttributes(NSPoint::new(x, 0.0), Some(&attrs));
        }
        x += column_width;
    }
    NSGraphicsContext::restoreGraphicsState_class();
    let logical = NSSize::new(width / 2.0, 22.0);
    rep.setSize(logical);
    Ok((rep, logical))
}

pub(super) fn draw(app: &AppHandle, groups: &[SummaryGroup], style: SummaryStyle, generation: u64) -> Result<bool, String> {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSImage, NSVariableStatusItemLength};
    let groups = groups.to_vec();
    let tray = app.tray_by_id("tray").ok_or_else(|| PAINT_ERROR.to_string())?;
    tray.with_inner_tray_icon(move |inner| {
        let mtm = MainThreadMarker::new().ok_or_else(|| PAINT_ERROR.to_string())?;
        let (rep, logical) = render_bitmap(&groups, style)?;
        let image = NSImage::initWithSize(NSImage::alloc(), logical);
        image.addRepresentation(&rep);
        image.setTemplate(true);
        let tooltip = tooltip(&groups, style);
        // Bitmap/font work stays outside the lock, so a configure timeout or
        // disable can invalidate this callback before any status-item mutation.
        let locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !accepts_generation(&locked, generation) { return Ok(false); }
        let item = inner.ns_status_item().ok_or_else(|| PAINT_ERROR.to_string())?;
        let button = item.button(mtm).ok_or_else(|| PAINT_ERROR.to_string())?;
        item.setLength(NSVariableStatusItemLength);
        button.setImage(Some(&image));
        // Public setters also resize tray-icon's overlaid click target and keep
        // its attributes consistent for switching back to a legacy style.
        inner.set_title(Some(""));
        inner.set_tooltip(Some(&tooltip)).map_err(|_| PAINT_ERROR.to_string())?;
        Ok(true)
    }).map_err(|_| PAINT_ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(id: &str, keys: [&str; 2], values: [Option<u8>; 2]) -> SummaryGroup {
        SummaryGroup { id: id.into(), name: id.into(), rows: keys.into_iter().zip(values).map(|(key, percent)| SummaryRow {
            key: key.into(), label: key.into(), remaining_percent: percent, countdown: Some("4h12m".into()), status: "fresh",
        }).collect() }
    }
    #[test]
    fn compact_keeps_both_periods_and_uses_bigger_numbers_without_time_parts() {
        let groups = [sample("claude", ["session", "weekly"], [Some(100), Some(0)])];
        assert_eq!(compact_parts(&groups), vec![CompactPart::Icon("claude"), CompactPart::Space(4.0), CompactPart::Tag("S"), CompactPart::Space(2.0), CompactPart::Percent(Some(100)), CompactPart::Space(8.0), CompactPart::Tag("W"), CompactPart::Space(2.0), CompactPart::Percent(Some(0))]);
        assert!(COMPACT_FONT_PX > 18.0);
        assert!(!tooltip(&groups, SummaryStyle::Compact).contains("4h12m"));
        assert!(tooltip(&groups, SummaryStyle::Quota).contains("4h12m"));
    }
    #[test]
    fn antigravity_groups_two_distinct_model_icons_and_percentages() {
        let groups = [sample("antigravity", ["gemini", "claude"], [Some(95), Some(22)])];
        let parts = compact_parts(&groups);
        assert_eq!(parts.iter().filter_map(|part| if let CompactPart::Icon(id) = part { Some(*id) } else { None }).collect::<Vec<_>>(), vec!["antigravity", "gemini", "claude"]);
        assert_eq!(parts.iter().filter_map(|part| if let CompactPart::Percent(value) = part { Some(*value) } else { None }).collect::<Vec<_>>(), vec![Some(95), Some(22)]);
    }
    #[test]
    fn missing_percentage_stays_unknown_and_is_not_confused_with_zero() {
        assert_eq!(percent_text(None), "--");
        assert_eq!(percent_text(Some(0)), "0%");
        assert_eq!(percent_text(Some(100)), "100%");
        let groups = [sample("codex", ["session", "weekly"], [None, Some(100)])];
        let text = tooltip(&groups, SummaryStyle::Compact);
        assert!(text.contains("session 剩餘 --"));
        assert!(text.contains("weekly 剩餘 100%"));
        assert!(!text.contains("4h12m"));
    }
    #[test]
    fn all_bundled_services_and_both_models_have_embedded_brand_icons() {
        for id in ["amp", "antigravity", "claude", "codex", "copilot", "cursor", "devin", "factory", "grok", "jetbrains-ai-assistant", "kimi", "kiro", "minimax", "opencode-go", "perplexity", "synthetic", "zai", "gemini"] {
            assert!(icon_bytes(id).unwrap().starts_with(b"\x89PNG\r\n\x1a\n"), "{id}");
        }
        assert_ne!(icon_bytes("gemini"), icon_bytes("claude"));
        assert!(icon_bytes("unknown").is_none());
    }
    #[test]
    fn empty_selection_is_visible_and_service_groups_are_separated() {
        assert_eq!(compact_parts(&[]), vec![CompactPart::Tag("TU"), CompactPart::Space(6.0), CompactPart::Percent(None)]);
        let groups = [sample("claude", ["session", "weekly"], [None, None]), sample("codex", ["session", "weekly"], [Some(0), Some(100)])];
        assert_eq!(compact_parts(&groups).iter().filter(|part| matches!(part, CompactPart::Divider)).count(), 1);
    }
}
