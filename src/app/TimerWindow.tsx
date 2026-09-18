import { useEffect, useState } from "react";
import { Play, Pause, X } from "lucide-react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type TimerState, fmtSec } from "../lib/timer";
import { TIMER_WIN_DEFAULT } from "./useTimerWindow";

// 뜬 타이머 창(src-tauri가 별도 webview로 띄움)의 내용물. 메인 창과는 별개 프로세스의
// 별도 document라 상태를 직접 공유할 수 없어 Tauri 이벤트로만 주고받음 — 메인 창이
// "timer:state"를 브로드캐스트하면 받아서 그리고, 버튼을 누르면 "timer:action"을 보내서
// 메인 창의 startSession/endSession이 실행되게 함(Supabase 쓰기는 항상 메인 창에서만 발생).
type PomPhase = "focus" | "break";
type TimerStatePayload = {
  timerState: TimerState;
  timerSec: number;
  pomodoroOn?: boolean;
  pomPhase?: PomPhase;
  pomPhaseRemainSec?: number;
};

// 창 크기에 맞춰 내용물을 통째로 확대/축소한다.
//
// 기본 크기(260×120)를 기준 레이아웃으로 두고, 창이 커지거나 작아지면 그 비율만큼
// transform:scale 로 키운다. 글자·버튼·간격이 모두 같은 비율로 따라오므로 어떤 크기에서도
// 배치가 그대로다. 가로·세로 비율이 기준과 다르면 작은 쪽에 맞추고 남는 쪽은 여백.
function useContentScale() {
  const calc = () => Math.max(0.3, Math.min(
    window.innerWidth / TIMER_WIN_DEFAULT.width,
    window.innerHeight / TIMER_WIN_DEFAULT.height,
  ));
  const [scale, setScale] = useState(calc);
  useEffect(() => {
    const onResize = () => setScale(calc());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return scale;
}

export default function TimerWindow() {
  const [timerState, setTimerState] = useState<TimerState>("stopped");
  const [timerSec, setTimerSec] = useState(0);
  const [pomodoroOn, setPomodoroOn] = useState(false);
  const [pomPhase, setPomPhase] = useState<PomPhase>("focus");
  const [pomPhaseRemainSec, setPomPhaseRemainSec] = useState(0);
  // 메인 창에서 첫 상태를 받았는지. 받기 전에는 00:00 대신 --:-- 를 보여준다 —
  // 0초라고 단정해 버리면 "오늘 공부한 시간이 초기화됐다" 로 잘못 읽힌다.
  const [synced, setSynced] = useState(false);
  const scale = useContentScale();

  // 메인 창은 상태가 바뀔 때만 "timer:state" 를 쏘기 때문에, 타이머가 멈춰 있으면
  // 이 창을 띄워도 한동안(= 다음 변화까지) 아무 것도 오지 않아 00:00 이 그대로 남았다.
  // 리스너를 다 건 뒤 "timer:ready" 로 한 번 요청해서 지금까지 공부한 시간을 바로 받아온다.
  useEffect(() => {
    const unlisten = listen<TimerStatePayload>("timer:state", (e) => {
      setTimerState(e.payload.timerState);
      setTimerSec(e.payload.timerSec);
      setPomodoroOn(!!e.payload.pomodoroOn);
      setPomPhase(e.payload.pomPhase ?? "focus");
      setPomPhaseRemainSec(e.payload.pomPhaseRemainSec ?? 0);
      setSynced(true);
    });
    // listen 이 실제로 등록된 뒤에 요청해야 답이 유실되지 않는다.
    unlisten.then(() => { emit("timer:ready", {}); });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // "항상 위" 를 주기적으로 다시 건다.
  //
  // Windows 에서는 다른 프로그램(이클립스 같은 Java/SWT 앱 등)이 자기 창을 앞으로 올리는
  // 과정에서 이 창의 TOPMOST 상태가 풀려 다른 창 뒤로 숨는 일이 있다. 그러면 메인 창을
  // 켤 때 잠깐 보였다가 다른 앱으로 돌아서는 순간 다시 사라진 것처럼 보인다.
  // 같은 값을 다시 거는 것은 부작용이 없고 아주 싸므로, 몇 초에 한 번씩 되풀이해서 어떤
  // 경우에도 몇 초 안에 다시 맨 위로 올라오게 한다.
  useEffect(() => {
    const win = getCurrentWindow();
    const reassert = () => { win.setAlwaysOnTop(true).catch(() => {}); };
    const id = window.setInterval(reassert, 3000);
    // 창이 다시 보이게 되는 순간(다른 창에서 돌아옴 등)에도 즉시 한 번.
    const onVis = () => { if (!document.hidden) reassert(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Ctrl+Space — 이 창에 포커스가 있을 때 시작/정지 토글. 메인 창과 같은 단축키.
  // 실제 시작/정지 판단은 메인 창이 하므로 여기서는 "toggle" 만 보낸다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      if (e.code !== "Space" && e.key !== " ") return;
      e.preventDefault();
      emit("timer:action", { type: "toggle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isRunning = timerState === "running";
  const isAutoPaused = timerState === "auto-paused";
  const isBreak = pomodoroOn && isRunning && pomPhase === "break";
  // 뜬 타이머는 다른 앱 위에 항상 떠 있으므로, 돌아가는 동안에는 반투명으로 물러나 아래 화면을
  // 가리지 않게 하고, 멈춰 있을 때(정지·자동 일시정지)는 눈에 띄도록 또렷하게 보여줌.
  // 돌아가는 중이라도 마우스를 올리면 원래 선명도로 돌아와 정지 버튼을 정확히 누를 수 있음.
  const dimmed = isRunning;

  const start = () => emit("timer:action", { type: "start" });
  const stop = () => emit("timer:action", { type: "stop" });
  const closeWindow = () => getCurrentWindow().close();
  // 오른쪽 아래 모서리 그립 — 테두리 없는 창은 가장자리 잡기가 어려워, 확실한 손잡이를 하나 둔다.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow().startResizeDragging("SouthEast").catch(() => {});
  };

  return (
    <div
      data-tauri-drag-region
      className={`relative h-screen w-screen overflow-hidden flex items-center justify-center rounded-xl transition-opacity duration-300 ${
        isBreak ? "bg-indigo-50" : isRunning ? "bg-sky-50" : isAutoPaused ? "bg-amber-50" : "bg-card border border-border shadow-lg"
      } ${dimmed ? "opacity-40 hover:opacity-100" : "opacity-100"}`}
    >
      {/* 기준 크기의 레이아웃을 창 크기에 맞춰 통째로 확대/축소 */}
      <div
        data-tauri-drag-region
        className="flex flex-col items-center justify-center gap-1 flex-shrink-0"
        style={{ width: TIMER_WIN_DEFAULT.width, height: TIMER_WIN_DEFAULT.height, transform: `scale(${scale})`, transformOrigin: "center" }}
      >
        <button
          onClick={closeWindow}
          title="닫기"
          className="absolute top-1.5 right-1.5 p-1 rounded-md hover:bg-black/10 text-muted-foreground"
        >
          <X size={12} />
        </button>

        {pomodoroOn && isRunning && (
          <div className={`text-[10px] font-medium tabular-nums ${isBreak ? "text-indigo-700" : "text-sky-700"}`}>
            {isBreak ? "휴식" : "집중"} · {fmtSec(pomPhaseRemainSec)}
          </div>
        )}

        <div
          data-tauri-drag-region
          className={`text-3xl font-medium tabular-nums ${
            isBreak ? "text-indigo-800" : isRunning ? "text-sky-800" : isAutoPaused ? "text-amber-800" : "text-muted-foreground"
          }`}
        >
          {synced ? fmtSec(timerSec) : "--:--"}
        </div>
        <div className="flex gap-2">
          {timerState === "stopped" && (
            <button onClick={start} title="시작 (Ctrl+Space)" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium">
              <Play size={11} fill="white" /> 시작
            </button>
          )}
          {isRunning && (
            <button onClick={stop} title="정지 (Ctrl+Space)" className="p-2 rounded-lg bg-muted text-muted-foreground">
              <Pause size={14} fill="currentColor" />
            </button>
          )}
          {isAutoPaused && (
            <>
              <button onClick={start} title="재시작 (Ctrl+Space)" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium">
                <Play size={11} fill="white" /> 재시작
              </button>
              <button onClick={stop} title="정지" className="p-2 rounded-lg bg-muted text-muted-foreground">
                <Pause size={14} fill="currentColor" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* 크기 조절 그립 — 창 자체의 오른쪽 아래 모서리에 고정(확대/축소 대상 아님) */}
      <div
        onMouseDown={startResize}
        title="드래그해서 크기 조절"
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize opacity-40 hover:opacity-90"
      >
        <svg viewBox="0 0 10 10" className="w-full h-full text-muted-foreground" fill="currentColor">
          <circle cx="8" cy="8" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="8" cy="5" r="1" /><circle cx="2" cy="8" r="1" /><circle cx="8" cy="2" r="1" /><circle cx="5" cy="5" r="1" />
        </svg>
      </div>
    </div>
  );
}
