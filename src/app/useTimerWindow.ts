import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

// 뜬 타이머 창의 기본 크기(논리 px). 사용자가 옮기거나 크기를 바꾸면 그 값을 저장해 두고,
// 다음에 띄울 때 같은 자리·같은 크기로 다시 만든다.
export const TIMER_WIN_DEFAULT = { width: 260, height: 120 };
export const TIMER_WIN_MIN = { width: 150, height: 70 };
const TIMER_WIN_BOUNDS_KEY = "timer_window_bounds";

type TimerWinBounds = { x: number; y: number; width: number; height: number };

function loadTimerBounds(): TimerWinBounds | null {
  try {
    const raw = localStorage.getItem(TIMER_WIN_BOUNDS_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw);
    if (![b.x, b.y, b.width, b.height].every((v: unknown) => typeof v === "number" && Number.isFinite(v))) return null;
    return b as TimerWinBounds;
  } catch { return null; }
}

function saveTimerBounds(b: TimerWinBounds) {
  try { localStorage.setItem(TIMER_WIN_BOUNDS_KEY, JSON.stringify(b)); } catch {}
}

// 저장된 위치가 지금 연결된 모니터 어딘가에 실제로 걸쳐 있는지. 모니터를 뺐거나 해상도가
// 바뀐 뒤라면 화면 밖 좌표가 남아 있을 수 있는데, 그대로 쓰면 창이 보이지 않는 곳에 떠서
// "타이머가 사라졌다" 가 된다. 확인이 불가능하면(권한 등) 저장값을 그냥 믿는다.
async function boundsOnScreen(b: TimerWinBounds): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return true;
    return monitors.some(m => {
      const mx = m.position.x / m.scaleFactor, my = m.position.y / m.scaleFactor;
      const mw = m.size.width / m.scaleFactor, mh = m.size.height / m.scaleFactor;
      // 창의 일부(최소 40px)라도 모니터 안에 있으면 잡을 수 있으니 허용.
      return b.x + b.width - 40 >= mx && b.x + 40 <= mx + mw && b.y + 20 >= my && b.y + 20 <= my + mh;
    });
  } catch { return true; }
}

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

  // 창을 옮기거나 크기를 바꿀 때마다 마지막 값을 기억해 둔다. 이벤트는 물리 px 로 오므로
  // 논리 px 로 바꿔 저장 — 생성 옵션(x/y/width/height)이 논리 px 이라 그대로 되돌려 쓸 수 있다.
  const trackBounds = (win: WebviewWindow) => {
    let last: TimerWinBounds | null = null;
    const flush = async () => {
      try {
        const scale = await win.scaleFactor();
        const pos = await win.outerPosition();
        const size = await win.innerSize();
        const next = { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
        // 최소화 등으로 이상한 값(음수 크기·화면 밖 -32000)이 오면 무시.
        if (next.width < 40 || next.height < 40 || next.x < -20000 || next.y < -20000) return;
        last = next;
        saveTimerBounds(next);
      } catch {}
    };
    // 드래그 중엔 이벤트가 초당 수십 번 오므로 살짝 미뤄서 마지막 값만 저장.
    let timer: number | undefined;
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(flush, 150); };
    const unlistens: Promise<() => void>[] = [win.onMoved(schedule), win.onResized(schedule)];
    return () => { window.clearTimeout(timer); unlistens.forEach(p => p.then(fn => fn()).catch(() => {})); return last; };
  };

  const open = async () => {
    const existing = await WebviewWindow.getByLabel("timer");
    if (existing) {
      // (개발 중 메인 창만 새로고침된 경우 등) 이미 떠 있는 창을 다시 붙잡는다.
      winRef.current = existing;
      setIsOpen(true);
      const stop = trackBounds(existing);
      existing.once("tauri://destroyed", () => { stop(); winRef.current = null; setIsOpen(false); });
      return;
    }
    const saved = loadTimerBounds();
    const usable = saved && (await boundsOnScreen(saved)) ? saved : null;
    const win = new WebviewWindow("timer", {
      url: "/timer.html",
      width: usable?.width ?? TIMER_WIN_DEFAULT.width,
      height: usable?.height ?? TIMER_WIN_DEFAULT.height,
      // 마지막으로 옮겨 둔 자리에 다시 띄운다. 저장된 게 없으면 OS 기본 위치.
      ...(usable ? { x: usable.x, y: usable.y } : {}),
      minWidth: TIMER_WIN_MIN.width,
      minHeight: TIMER_WIN_MIN.height,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      // 창 가장자리를 끌어 크기를 바꿀 수 있게. 내용물은 창 크기에 비례해 커지고 작아진다(TimerWindow).
      resizable: true,
      skipTaskbar: true,
      title: "타이머",
      // Windows에서 WebView2의 파일 드래그앤드롭 기능이 data-tauri-drag-region으로 창을
      // 옮기는 기능과 내부적으로 충돌해 꺼야 창 이동이 정상 동작함
      dragDropEnabled: false,
    });
    winRef.current = win;
    let stopTracking: (() => TimerWinBounds | null) | null = null;
    win.once("tauri://error", (e) => console.error("타이머 창 생성 실패", e));
    win.once("tauri://created", () => { setIsOpen(true); stopTracking = trackBounds(win); });
    win.once("tauri://destroyed", () => {
      stopTracking?.();
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
