import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

// 브라우저 Document PiP를 대체하는 진짜 Tauri 자식 창 — 다른 앱 위에서도 계속 떠 있고
// 테두리가 전혀 없음(frameless/transparent/alwaysOnTop). 상태 동기화는 useTimerBroadcast의
// emit/listen("timer:state" / "timer:action")로 이루어짐 — 여기선 창 생성/파괴만 다룸.
// onBeforeExit — 앱이 닫히기 직전에 await 되는 정리 훅(실행 중인 타이머 세션 마감 등).
// 여기서 마감하면 종료 시각이 초 단위까지 정확해지고, 강제 종료로 이게 못 돌더라도
// 세션의 last_alive_at 기반 정리가 다음 실행에서 대신 처리함.
export function useTimerWindow(onBeforeExit?: () => Promise<void> | void) {
  const [isOpen, setIsOpen] = useState(false);
  const winRef = useRef<WebviewWindow | null>(null);
  // effect 의 deps 가 []라 최신 콜백을 ref 로 읽음(App 이 매 렌더 새 함수를 넘김).
  const onBeforeExitRef = useRef(onBeforeExit);
  onBeforeExitRef.current = onBeforeExit;

  const open = async () => {
    const existing = await WebviewWindow.getByLabel("timer");
    if (existing) {
      winRef.current = existing;
      setIsOpen(true);
      return;
    }
    const win = new WebviewWindow("timer", {
      url: "/timer.html",
      width: 260,
      height: 120,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      title: "타이머",
      // Windows에서 WebView2의 파일 드래그앤드롭 기능이 data-tauri-drag-region으로 창을
      // 옮기는 기능과 내부적으로 충돌해 꺼야 창 이동이 정상 동작함
      dragDropEnabled: false,
    });
    winRef.current = win;
    win.once("tauri://error", (e) => console.error("타이머 창 생성 실패", e));
    win.once("tauri://created", () => setIsOpen(true));
    win.once("tauri://destroyed", () => {
      winRef.current = null;
      setIsOpen(false);
    });
  };

  const close = () => {
    winRef.current?.close();
  };

  // 메인 창의 X 버튼을 눌렀을 때 프로세스 전체를 확실히 종료시킴.
  //
  // 예전 구현은 async 핸들러에서 `await winRef.current?.close()`만 하고 preventDefault를
  // 안 걸었는데, Tauri v2 내부 리스너는 `await handler(evt)` 후에야 `this.destroy()`를
  // JS에서 호출하는 구조라서 우리 핸들러가 예외를 던지거나 hang하면 destroy가 아예
  // 호출되지 않아 메인 창이 그대로 살아 있고 작업 관리자로만 종료할 수 있었음.
  // (예: 뜬 타이머 창을 열었다가 stale 상태에서 close()가 예외를 던지는 경우 등)
  //
  // 이제는 preventDefault로 기본 close 로직을 우리가 대체하고, 자식 창까지 닫은 뒤
  // exit(0)으로 프로세스 전체를 강제 종료. 조용히 실패하는 지점 없이 확실히 닫힘.
  // onCloseRequested는 Promise로 unlisten을 돌려줌 — cleanup이 promise 이전에
  // 실행되면 unlisten이 안 되므로, cancelled 플래그를 두고 promise resolve 후에도
  // 정리 가능하도록 함.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try { await onBeforeExitRef.current?.(); } catch (e) { console.error("종료 전 정리 실패", e); }
        try { await winRef.current?.close(); } catch (e) { console.error("타이머 창 닫기 실패", e); }
        try { await exit(0); } catch (e) { console.error("앱 종료 실패", e); }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { isOpen, open, close };
}
