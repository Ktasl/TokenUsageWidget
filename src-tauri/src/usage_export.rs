use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::Manager;

const MAX_EXPORT_BYTES: usize = 2 * 1024 * 1024;

fn validate_export(filename: &str, contents: &str, mime: &str) -> Result<(), String> {
    let suffix = match mime {
        "application/json" => ".json",
        "text/csv" | "text/csv;charset=utf-8" => ".csv",
        _ => return Err("不支援的匯出格式".into()),
    };
    let stem = filename.strip_prefix("TokenUsageWidget-")
        .and_then(|name| name.strip_suffix(suffix))
        .filter(|stem| !stem.is_empty() && stem.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    if filename.len() > 128 || stem.is_none() {
        return Err("匯出檔名格式不正確".into());
    }
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("匯出內容超過 2 MB 限制".into());
    }
    if mime == "application/json" && serde_json::from_str::<serde_json::Value>(contents).is_err() {
        return Err("JSON 匯出內容格式不正確".into());
    }
    Ok(())
}

// The caller supplies the OS Downloads directory, never a path from the frontend.
fn save_export_at(downloads: &Path, filename: &str, contents: &str, mime: &str) -> Result<String, String> {
    validate_export(filename, contents, mime)?;
    let directory = downloads.join("TokenUsageWidget");
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("無法建立用量匯出資料夾".into()),
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "無法讀取匯出資料夾".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("匯出資料夾必須是一般資料夾".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(directory.join(filename)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists { "同名匯出檔案已存在，請改用新的檔名".to_string() }
        else { "無法建立匯出檔案".to_string() }
    })?;
    file.write_all(contents.as_bytes()).map_err(|_| "匯出檔案寫入失敗".to_string())?;
    file.sync_all().map_err(|_| "匯出檔案儲存失敗".to_string())?;
    Ok(filename.to_string())
}

#[tauri::command]
pub async fn save_usage_export(app_handle: tauri::AppHandle, filename: String, contents: String, mime: String) -> Result<String, String> {
    let downloads = app_handle.path().download_dir().map_err(|_| "無法取得下載資料夾".to_string())?;
    save_export_at(&downloads, &filename, &contents, &mime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_downloads() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("tokenusagewidget-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        directory
    }

    #[test]
    fn validates_basename_mime_and_payload_limit() {
        for filename in ["../TokenUsageWidget-test.json", "/tmp/TokenUsageWidget-test.json", "TokenUsageWidget-../secret.json", "TokenUsageWidget-test.csv", "TokenUsageWidget-.json", "TokenUsageWidget-test\\file.json"] {
            assert!(validate_export(filename, "{}", "application/json").is_err());
        }
        assert!(validate_export("TokenUsageWidget-2026-10-25.json", "{}", "application/json").is_ok());
        assert!(validate_export("TokenUsageWidget-2026-10-25.csv", "date,tokens\n", "text/csv;charset=utf-8").is_ok());
        assert!(validate_export("TokenUsageWidget-test.json", "not-json", "application/json").is_err());
        assert!(validate_export("TokenUsageWidget-test.csv", "x", "text/html").is_err());
        assert!(validate_export("TokenUsageWidget-test.csv", &"x".repeat(MAX_EXPORT_BYTES + 1), "text/csv").is_err());
    }

    #[test]
    fn exports_only_to_fixed_child_and_does_not_overwrite() {
        let downloads = temporary_downloads();
        let name = "TokenUsageWidget-2026-10-25.json";
        assert_eq!(save_export_at(&downloads, name, "{\"tokens\":10}", "application/json").unwrap(), name);
        assert!(save_export_at(&downloads, name, "{\"tokens\":999}", "application/json").is_err());
        assert_eq!(fs::read_to_string(downloads.join("TokenUsageWidget").join(name)).unwrap(), "{\"tokens\":10}");
        assert!(save_export_at(&downloads, "../TokenUsageWidget-escape.json", "{}", "application/json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_export_directory() {
        let downloads = temporary_downloads();
        let outside = temporary_downloads();
        std::os::unix::fs::symlink(&outside, downloads.join("TokenUsageWidget")).unwrap();
        let error = save_export_at(&downloads, "TokenUsageWidget-test.json", "{}", "application/json").unwrap_err();
        assert_eq!(error, "匯出資料夾必須是一般資料夾");
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}
