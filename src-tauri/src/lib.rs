#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      // macOS 전용: 창 생성 시점의 maximized:true 대신 webview 가 붙은 뒤 최대화한다.
      // decorations:false 인 macOS 창은 borderless NSWindow 라 생성 시점에 지정한 최대화
      // 지오메트리를 콘텐츠 뷰가 따라오지 못하는 경우가 있고, 그러면 webview 가 창보다
      // 작게 남아 오른쪽·아래에 네이티브 창 배경(회색)이 드러난다. 여기서 명시적으로
      // maximize() 를 호출하면 정상적인 resize 가 발생해 webview 가 창 크기에 맞춰진다.
      // (tauri.macos.conf.json 에서 maximized 를 false 로 내려두었다.)
      // Windows/Linux 는 기존 동작 그대로 — tauri.conf.json 의 maximized:true 가 적용된다.
      #[cfg(target_os = "macos")]
      {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("main") {
          if let Err(e) = win.maximize() {
            log::warn!("macOS 초기 최대화 실패: {e}");
          }
        }
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
