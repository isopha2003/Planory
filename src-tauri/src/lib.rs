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
    // 다른 앱을 쓰는 중에도 타이머를 시작/정지할 수 있는 시스템 전역 단축키(등록은 아래 setup 에서).
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .setup(|app| {
      // 시스템 전역 타이머 단축키(Ctrl+Alt+P) — 다른 앱을 쓰는 중에도 타이머를 켜고 끈다.
      //
      // JS 가 아니라 여기서 등록하는 이유: 웹뷰 쪽에서 등록하면 페이지가 다시 로드될 때(개발 중
      // HMR, 업데이트 후 재로드 등) 이전 페이지가 걸어둔 등록이 프로세스에 그대로 남아 새 등록이
      // "already registered" 로 실패하고, 옛 핸들러는 사라진 페이지를 가리켜 아무 일도 하지 않는다.
      // 프로세스당 한 번만 등록하고 이벤트로 넘기면 프론트가 몇 번을 다시 떠도 계속 동작한다.
      //
      // 등록 실패(다른 프로그램이 같은 조합을 선점)는 경고만 남기고 앱은 그대로 뜬다 —
      // 앱 안 단축키(Ctrl+Space)는 영향이 없다.
      {
        use tauri::Emitter;
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        let result = app.global_shortcut().on_shortcut("ctrl+alt+p", |app, _shortcut, event| {
          if event.state() == ShortcutState::Pressed {
            if let Err(e) = app.emit("timer:action", serde_json::json!({ "type": "toggle" })) {
              log::warn!("전역 단축키 이벤트 전달 실패: {e}");
            }
          }
        });
        if let Err(e) = result {
          log::warn!("전역 타이머 단축키(Ctrl+Alt+P) 등록 실패: {e}");
        }
      }
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
