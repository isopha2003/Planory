import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2, Circle, Clock, Play, Pause,
  Plus, X, ChevronLeft, ChevronRight, ChevronDown,
  BarChart2, Settings, Calendar, Target, Flame, FileText,
  Edit3, Check, AlertCircle, PictureInPicture2 as PictureInPicture,
  Folder, FolderPlus, MoreVertical, ArrowLeft, ArrowUpDown, Trash2,
  Minus, Square, Copy, Palette,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  fetchTemplates, createTemplate, deleteTemplateRow, fetchBlocks, insertBlock, patchBlock, deleteBlockRow,
  deleteBlocksByRepeatGroup as apiDeleteRepeatGroup, deleteRepeatInstancesExceptOrigin, insertBlocksBulk,
  fetchDeadlines, createDeadline, toggleDeadlineRow, updateDeadlineRow, deleteDeadlineRow,
  fetchKanbanCards, createKanbanCard, updateKanbanCard, deleteKanbanCardRow, bulkUpdateKanbanCardOrder,
  fetchKanbanChecklistItemsByDeadline, createKanbanChecklistItem, toggleKanbanChecklistItemRow, deleteKanbanChecklistItemRow,
  type KanbanCard, type KanbanStatus, type KanbanChecklistItem,
  fetchTodos, createTodo, updateTodo, toggleTodoRow, deleteTodoRow, bulkUpdateTodoOrder, type Todo,
  insertTodosBulk, deleteTodoRepeatInstancesExceptOrigin, deleteTodosByRepeatGroup as apiDeleteTodoRepeatGroup,
  fetchTodaySessions, startTimerSession, endTimerSession, deleteTodaySessions, fetchFocusSecByDate,
  fetchChecklistItems, createChecklistItem, toggleChecklistItemRow, deleteChecklistItemRow,
  fetchTodoChecklistItems, createTodoChecklistItem, toggleTodoChecklistItemRow, deleteTodoChecklistItemRow,
  fetchAllTodoChecklistItems,
  fetchNotes, createNote, updateNote, deleteNote, moveNoteToFolder, reorderNotes,
  fetchNoteFolders, createFolder, updateFolder, deleteFolder, reorderFolders,
  type Note, type NoteFolder,
} from "../lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type TimerState, fmtSec } from "../lib/timer";
import { runAutoBackupIfNeeded, createBackupNow, getLastBackupTimestamp } from "../lib/backup";
import { checkForUpdate, installUpdate, type UpdateCheckResult } from "../lib/updater";
import { notifyError } from "../lib/notify";
import { getHoliday, isHoliday } from "../lib/holidays";
import { Toaster } from "./components/ui/sonner";
import { emit, listen } from "@tauri-apps/api/event";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useTimerWindow } from "./useTimerWindow";

// ── Types ──────────────────────────────────────────────────────────
interface Block {
  id: string;
  templateId?: string;
  parentBlockId?: string;
  title: string;
  // DB 컬럼은 유지되지만 렌더링에는 사용하지 않음 — 색상은 카테고리에서 자동 조회.
  color: string;
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  completed: boolean;
  tags: string[];
  memo: string;
  // 소속 카테고리 이름 — block_templates(kind='todo').title 과 문자열 매칭.
  // 색상은 이 문자열로 카테고리를 찾아서 사용(getCategoryColor). 빈 문자열이면 미분류.
  category: string;
  date: string;
  repeat?: BlockRepeat;
  repeatGroupId?: string;
  nextBlockId?: string;
  // 오늘 달성률 계산에 포함할지. 기본 true — 특정 블록(자유시간, 이동 등)을 통계에서
  // 빼고 싶을 때만 상세 패널 토글로 false 로 바꿈.
  countInCompletion: boolean;
}

interface Deadline {
  id: string;
  title: string;
  dueDate: string;
  completed: boolean;
  // 마감 개별 색상 — 빈 문자열이면 D-day 톤을 따라감(기본).
  color: string;
}

interface Template {
  id: string;
  title: string;
  color: string;
  tags: string[];
  // 'time' = 시간대별 블록 템플릿, 'todo' = 시간대 없이 할 일 목록 템플릿.
  kind: "time" | "todo";
}

interface BlockRepeat {
  type: "daily" | "weekly" | "monthly" | "yearly";
  days: number[];        // 0–6 (Sun–Sat), weekly 에서만 사용
  endType: "none" | "count" | "date";
  endCount: number;
  endDate: string;       // ISO date string
}

interface TimerSession {
  id: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  endReason: "manual" | "auto" | "ongoing";
}

interface ChecklistItemT {
  id: string;
  blockId: string;
  parentItemId?: string;
  text: string;
  completed: boolean;
  sortOrder: number;
}

// Todo 체크리스트 항목 — blocks 의 ChecklistItemT 와 동일한 구조이지만 소유 ID 필드명이 다름.
// ChecklistNode 는 이 두 타입을 동일한 인터페이스로 다룸(id/parentItemId/text/completed 만 사용).
interface TodoChecklistItemT {
  id: string;
  todoId: string;
  parentItemId?: string;
  text: string;
  completed: boolean;
  sortOrder: number;
}

type Section = "today" | "calendar" | "deadlines" | "grass" | "memo" | "settings";

// ── Helpers ────────────────────────────────────────────────────────
// Local calendar date -> "YYYY-MM-DD", WITHOUT going through UTC (unlike .toISOString().slice(0,10),
// which rolls back to the previous day for any positive UTC offset — e.g. Asia/Seoul UTC+9 turns
// local midnight July 1st into "2026-06-30". This reads the local Y/M/D components directly.
const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// "YYYY-MM-DD" -> local Date at that day's midnight. `new Date("YYYY-MM-DD")` parses the string
// as UTC per spec, which is the mirror-image bug of toDateStr above (this direction bites
// negative-UTC-offset users). Building via the (y, m, d) constructor form is always local.
const parseLocalDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
// 두 로컬 날짜(자정) 사이의 정수 일수 차이. Date.UTC로 각 날짜를 timezone-agnostic한 UTC
// 자정으로 변환해 뺀 뒤 86400000으로 나눔 — 이렇게 하면 DST 전환(하루가 23h 또는 25h)이
// 있는 지역에서도 항상 정확한 정수 일수가 나옴. 예전엔 `(t2 - t1) / 86400000`을
// Math.ceil해서 DST fall-back 시 "내일" 마감이 D-2로 표시되는 등 오차가 생겼음.
const daysBetween = (a: Date, b: Date) => {
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((aUTC - bUTC) / 86400000);
};
// 마감까지 남은 일수(daysLeft) 기반 시각 톤 — D-day 배지·좌측 스트라이프·카드 배경/보더를
// 한꺼번에 결정. >10일 초록, 6~10일 노랑, 4~5일 주황, ≤3일(오늘·지난 마감 포함) 빨강.
// 아래 클래스 문자열은 리터럴이라 Tailwind v4 소스 스캐너가 그대로 감지함.
type DeadlineTone = {
  stripe: string; badge: string; hoverBorder: string;
  circle: string; circleHollow: string; bg: string; border: string;
};
const deadlineTone = (daysLeft: number): DeadlineTone => {
  if (daysLeft > 10) return {
    stripe: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700",
    hoverBorder: "hover:border-emerald-300", circle: "text-emerald-500",
    circleHollow: "text-emerald-400", bg: "bg-emerald-50", border: "border-emerald-200",
  };
  if (daysLeft > 5) return {
    stripe: "bg-yellow-500", badge: "bg-yellow-100 text-yellow-700",
    hoverBorder: "hover:border-yellow-300", circle: "text-yellow-500",
    circleHollow: "text-yellow-400", bg: "bg-yellow-50", border: "border-yellow-200",
  };
  if (daysLeft > 3) return {
    stripe: "bg-orange-500", badge: "bg-orange-100 text-orange-700",
    hoverBorder: "hover:border-orange-300", circle: "text-orange-500",
    circleHollow: "text-orange-400", bg: "bg-orange-50", border: "border-orange-200",
  };
  return {
    stripe: "bg-red-500", badge: "bg-red-100 text-red-700",
    hoverBorder: "hover:border-red-300", circle: "text-red-500",
    circleHollow: "text-red-400", bg: "bg-red-50", border: "border-red-200",
  };
};
// 인라인 style 로 마감 톤을 그릴 때(캘린더 시간 그리드 헤더·월/리스트/TodoPanel 셀 등) 사용.
// Tailwind 클래스가 아니라 hex 문자열이 필요한 경우 — 색상+"28" 로 배경 tint, 그대로 border/text 로.
const deadlineToneHex = (daysLeft: number): string => {
  if (daysLeft > 10) return "#10B981"; // emerald-500
  if (daysLeft > 5) return "#EAB308";  // yellow-500
  if (daysLeft > 3) return "#F97316";  // orange-500
  return "#EF4444";                    // red-500
};
// D-{n} / D+{n} 표기. 오늘 = D-0, 미래 = D-n, 지난 마감 = D+n.
const formatDDay = (daysLeft: number): string =>
  daysLeft >= 0 ? `D-${daysLeft}` : `D+${Math.abs(daysLeft)}`;
// 자정 롤오버: 아래 세 값은 컴포넌트들이 프op이 아니라 모듈 전역 변수로 직접 참조하고 있어서
// (예: TodaySection 안에서 `TODAY_STR` 그대로 사용), `let`로 두고 재할당하면 다음 렌더링부터
// 모든 곳에서 자동으로 새 값을 읽게 됨. 실제로 리렌더를 발생시키는 건 App()의 tick 로직.
let TODAY_STR = toDateStr(new Date());

const fmt2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (h: number, m: number) => `${fmt2(h)}:${fmt2(m)}`;
const durMin = (b: Block) => (b.endH * 60 + b.endM) - (b.startH * 60 + b.startM);
const DAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
const MONTHS_KO = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
let TODAY_DATE = parseLocalDate(TODAY_STR);

// 할 일 정렬 — 카테고리 오름차순, 카테고리 없는(빈 문자열) 항목은 맨 아래로.
// 같은 카테고리 안에서는 기존 sortOrder(사용자 드래그 순서) 유지.
const sortTodosByCategory = <T extends { category?: string; sortOrder: number }>(list: T[]): T[] =>
  [...list].sort((a, b) => {
    const ac = (a.category ?? "").trim();
    const bc = (b.category ?? "").trim();
    if (!ac && bc) return 1;
    if (ac && !bc) return -1;
    const cmp = ac.localeCompare(bc, "ko");
    return cmp !== 0 ? cmp : a.sortOrder - b.sortOrder;
  });

// 카테고리별로 묶어 [{ category, todos }] 배열로 반환 — UI가 그룹 헤더 + 구분선을 그릴 수 있게.
// 미분류(빈 문자열)는 마지막 그룹이 됨.
const groupTodosByCategory = <T extends { category?: string; sortOrder: number }>(list: T[]): { category: string; todos: T[] }[] => {
  const sorted = sortTodosByCategory(list);
  const groups: { category: string; todos: T[] }[] = [];
  for (const t of sorted) {
    const cat = (t.category ?? "").trim();
    const last = groups[groups.length - 1];
    if (last && last.category === cat) last.todos.push(t);
    else groups.push({ category: cat, todos: [t] });
  }
  return groups;
};

// 미분류(카테고리 없음) todo 의 색상 — 회색 톤. 카테고리를 지정하지 않은 상태에서만 사용.
const UNCATEGORIZED_TODO_COLOR = "#94A3B8";

// 카테고리 이름 → 색상 조회. templates 중 kind='todo' 인 것에서 title 매칭.
// 매칭 실패(카테고리 삭제/미분류)면 회색 기본색. 렌더링·상세 패널·드래그 모든 경로가 이 함수를
// 거쳐야 카테고리 색 변경이 자동으로 반영됨(todos.color 컬럼은 무시).
const getCategoryColor = <T extends { title: string; color: string; kind: "time" | "todo" }>(
  templates: T[],
  category?: string,
): string => {
  const name = (category ?? "").trim();
  if (!name) return UNCATEGORIZED_TODO_COLOR;
  const tpl = templates.find(t => t.kind === "todo" && t.title === name);
  return tpl?.color ?? UNCATEGORIZED_TODO_COLOR;
};

// 두 음(A5→E6) 상승 chime — Web Audio로 코드에서 직접 생성해 파일/OS 사운드 설정에
// 의존하지 않고 확실히 재생. 사용자 클릭으로 뽀모도로가 시작된 뒤에만 호출되므로
// autoplay 정책에 걸리지 않음.
function playChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const play = (freq: number, start: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(0.35, now + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.start(now + start);
      o.stop(now + start + dur);
    };
    play(880, 0, 0.18);      // A5
    play(1320, 0.14, 0.28);  // E6
    setTimeout(() => { try { ctx.close(); } catch {} }, 800);
  } catch (e) { console.error(e); }
}

// 뽀모도로 phase 전환 시 OS 네이티브 알림 발송 + chime 재생 — 알림 권한 없으면 텍스트는
// 조용히 스킵하되 사운드는 재생 (사운드는 앱 자체 재생이라 권한 무관).
async function notifyPomodoro(title: string, body: string) {
  playChime();
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    sendNotification({ title, body });
  } catch (e) { console.error(e); }
}

// 실제 날짜가 바뀌었으면 위 세 변수를 갱신하고 true를 반환 (안 바뀌었으면 false)
function syncTodayIfChanged(): boolean {
  const real = toDateStr(new Date());
  if (real === TODAY_STR) return false;
  TODAY_STR = real;
  TODAY_DATE = parseLocalDate(TODAY_STR);
  return true;
}

// localStorage에 JSON으로 값을 저장/복원하는 useState 래퍼. darkMode/팔레트 색상처럼
// 재시작 후에도 유지돼야 하는 설정에 사용. 파싱 실패나 저장 실패는 조용히 무시하고
// 초기값으로 폴백 — 개인용 앱이라 스토리지 격리 이슈까지 방어할 필요는 없음.
function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {}
    return initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

// ── App ────────────────────────────────────────────────────────────
export default function App() {
  const [section, setSection] = useState<Section>("today");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  // Todo 체크리스트 항목 전체 — todo 카드 프리뷰(체크리스트 요약)와 상세 패널 편집이 같은
  // 상태를 공유. 소규모 데이터라 시작 시 한 번에 불러와 캐시.
  const [todoChecklistItems, setTodoChecklistItems] = useState<TodoChecklistItemT[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  // 할 일도 시간 블록처럼 상세 패널로 색상/메모 편집 가능. selectedBlock 과 상호배타 —
  // 하나가 열리면 다른 하나는 닫힘 (같은 오른쪽 패널 자리를 씀).
  const [selectedTodo, setSelectedTodo] = useState<Todo | null>(null);
  // 마감 작업도 시간 블록·할 일과 마찬가지로 상세 패널에서 제목/마감일 편집. 세 selected 상태는 상호배타 —
  // 하나가 열리면 다른 둘은 닫힘 (같은 오른쪽 패널 자리를 공유).
  const [selectedDeadline, setSelectedDeadline] = useState<Deadline | null>(null);
  const openBlockDetail = (b: Block | null) => { setSelectedBlock(b); if (b) { setSelectedTodo(null); setSelectedDeadline(null); } };
  const openTodoDetail = (t: Todo | null) => { setSelectedTodo(t); if (t) { setSelectedBlock(null); setSelectedDeadline(null); } };
  const openDeadlineDetail = (d: Deadline | null) => { setSelectedDeadline(d); if (d) { setSelectedBlock(null); setSelectedTodo(null); } };
  // 캘린더 클릭으로 방금 만들어진 블록 id — 상세 패널이 제목 편집 모드로 자동 진입하고,
  // 이 블록의 제목이 처음 저장될 때 매칭 템플릿을 좌측 사이드바에 자동 추가하는 트리거로 씀.
  const [justCreatedBlockId, setJustCreatedBlockId] = useState<string | null>(null);
  // Todo 도 동일 — 캘린더에서 새 할 일 프리뷰를 눌러 만든 직후엔 상세 패널이 제목 편집 모드로.
  const [justCreatedTodoId, setJustCreatedTodoId] = useState<string | null>(null);
  // 반복 블록 삭제 요청 — 이 블록만 지울지 / 이 블록 이후 전체를 지울지 사용자에게 물어보는 모달.
  // 반복 그룹에 속하지 않은 블록은 곧바로 삭제하고 이 state 는 건너뜀.
  const [repeatDeletePrompt, setRepeatDeletePrompt] = useState<{ id: string; date: string; title: string } | null>(null);
  // 반복 할 일 삭제 요청 — repeatDeletePrompt 의 todo 판.
  const [todoRepeatDeletePrompt, setTodoRepeatDeletePrompt] = useState<{ id: string; date: string; title: string } | null>(null);

  // 다중 블록 UX용 — 클립보드(Ctrl+C/V), 실행 취소 스택(Ctrl+Z), 다시 실행 스택(Ctrl+Y).
  // 클립보드는 블록의 얕은 스냅샷: 원본과 무관한 새 블록으로 붙여넣기 위해 date/id 만 재계산.
  // 실행 취소는 { undo, redo } 쌍의 스택 — undo 를 실행하면 그 쌍이 redo 스택으로 넘어가고,
  // 새 뮤테이션이 push 되면 redo 스택은 초기화(브랜치가 갈라졌으므로 앞선 redo 는 무의미).
  // redo 를 제공하지 않은 레거시 pushUndo 호출은 redo 가 no-op — 취소만 되고 다시 실행은 없음.
  type UndoEntry = { undo: () => Promise<void> | void; redo: () => Promise<void> | void };
  const [blockClipboard, setBlockClipboard] = useState<Block[]>([]);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const pushUndo = (undo: () => Promise<void> | void, redo?: () => Promise<void> | void) => {
    undoStackRef.current.push({ undo, redo: redo ?? (() => {}) });
    // 스택 무한 성장 방지 — 사용자가 세션 내 실수 되돌리기가 목적이라 30개면 충분.
    if (undoStackRef.current.length > 30) undoStackRef.current.shift();
    redoStackRef.current.length = 0;
  };
  const runUndo = async () => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.undo();
      redoStackRef.current.push(entry);
      if (redoStackRef.current.length > 30) redoStackRef.current.shift();
    } catch (e) { notifyError("실행 취소 실패")(e); }
  };
  const runRedo = async () => {
    const entry = redoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.redo();
      undoStackRef.current.push(entry);
      if (undoStackRef.current.length > 30) undoStackRef.current.shift();
    } catch (e) { notifyError("다시 실행 실패")(e); }
  };
  // 전역 Ctrl+Z (실행 취소) / Ctrl+Y · Ctrl+Shift+Z (다시 실행).
  // 입력 필드에서 타이핑 중이면 브라우저 기본 undo/redo 를 방해하지 않도록 스킵.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      if (!isUndo && !isRedo) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t as any)?.isContentEditable) return;
      e.preventDefault();
      if (isUndo) runUndo(); else runRedo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [tpls, blks, dls, tds, tcis] = await Promise.all([
          fetchTemplates(), fetchBlocks(), fetchDeadlines(), fetchTodos(),
          fetchAllTodoChecklistItems(),
        ]);
        setTemplates(tpls);
        setBlocks(blks);
        setDeadlines(dls);
        setTodos(tds);
        setTodoChecklistItems(tcis);
      } catch (e: any) {
        setLoadError(e.message ?? "데이터를 불러오지 못했습니다");
      } finally {
        setLoading(false);
      }
    })();
    // 하루 1회 자동 백업 (백그라운드 실행, 실패는 조용히 무시)
    runAutoBackupIfNeeded();
  }, []);

  // Global timer — single, app-wide. "자동 일시정지"는 사용자가 누르는 버튼이 아니라
  // 브라우저 탭 가시성(Page Visibility API)에 의해서만 진입/해제되는 상태.
  const [timerState, setTimerState] = useState<TimerState>("stopped");
  const [timerSec, setTimerSec] = useState(0);
  const [sessions, setSessions] = useState<TimerSession[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  // 과거 날짜별 누적 집중 시간(초) — 캘린더 히트맵에서 어제 이전 집중 시간을 표시할 때 사용.
  // 오늘은 실시간 timerSec을 별도로 쓰므로 여기엔 굳이 반영 안 함(포함되어도 무해).
  const [focusSecByDate, setFocusSecByDate] = useState<Record<string, number>>({});

  // 다크 모드 — localStorage에 저장해 재시작 시에도 유지. 첫 실행 기본값은 라이트.
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem("theme") === "dark"; } catch { return false; }
  });

  // 블록/템플릿 색상 팔레트 — 프리셋에서 시작해 사용자가 +로 커스텀 색 추가, X로 삭제 가능.
  // localStorage에 저장해 다음 실행에도 유지.
  const [paletteColors, setPaletteColors] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(BLOCK_PALETTE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) return parsed;
      }
    } catch {}
    return DEFAULT_BLOCK_COLORS;
  });
  const addPaletteColor = (color: string) => {
    setPaletteColors(prev => {
      const c = color.toLowerCase();
      if (prev.some(x => x.toLowerCase() === c)) return prev;
      const next = [...prev, color];
      try { localStorage.setItem(BLOCK_PALETTE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const removePaletteColor = (color: string) => {
    setPaletteColors(prev => {
      const c = color.toLowerCase();
      const next = prev.filter(x => x.toLowerCase() !== c);
      try { localStorage.setItem(BLOCK_PALETTE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add("dark");
    else root.classList.remove("dark");
    try { localStorage.setItem("theme", darkMode ? "dark" : "light"); } catch {}
  }, [darkMode]);

  // 글씨 크기 — 앱 전체 표시 배율(zoom)로 처리. Tailwind는 rem 기반 클래스가 있는 반면
  // 이 코드베이스엔 text-[11px] 같은 절대 px 클래스도 많아서, font-size로만 조절하면
  // 일부만 커지고 균형이 깨짐. zoom은 요소 크기·간격·경계까지 비례로 확대해줌.
  // WebView2(Windows)/WKWebView(macOS) 모두 zoom 지원.
  //
  // zoom을 <html>이 아니라 #root 에 적용하는 이유:
  // Radix Tooltip/Popover 등이 Portal 로 <body> 에 렌더링되는데, html 에 zoom 을 걸면
  // 그 Portal 요소가 zoom 된 서브트리 안에 있어서, Radix 가 getBoundingClientRect(시각 px)
  // 로 계산한 fixed 좌표에 브라우저가 zoom 을 한 번 더 곱해버려 툴팁이 엉뚱한 곳에 뜬다.
  // #root 에만 zoom 을 걸면 <body> 는 zoom 바깥이라 Portal 이 정상 위치로 렌더링됨.
  type FontSize = "normal" | "larger" | "large";
  const [fontSize, setFontSize] = usePersistedState<FontSize>("settings_font_size", "normal");
  useEffect(() => {
    const zoomMap: Record<FontSize, number> = { normal: 1, larger: 1.10, large: 1.20 };
    const z = zoomMap[fontSize];
    const root = document.getElementById("root");
    if (root) {
      root.style.zoom = String(z);
      // #root 가 zoom 배율만큼 커져 body 를 넘치지 않도록 뷰포트를 zoom 으로 나눠 크기 보정.
      root.style.width = `${100 / z}vw`;
      root.style.height = `${100 / z}vh`;
    }
    // 예전 버전에서 html 에 걸어둔 zoom 흔적 제거 — 남아있으면 이중 스케일이 됨.
    document.documentElement.style.removeProperty("zoom");
  }, [fontSize]);

  // Pomodoro / settings — timer effect들이 이 상태를 참조하므로 반드시 그 앞에서 선언돼야 함.
  // localStorage에 저장해 재시작 시에도 유지 — 예전엔 매번 초기값(꺼짐/25/5/꺼짐/15)로
  // 리셋돼서 유저가 앱 켤 때마다 다시 켜야 했음.
  const [pomodoroOn, setPomodoroOn] = usePersistedState("settings_pomodoro_on", false);
  const [pomWork, setPomWork] = usePersistedState("settings_pom_work", 25);
  const [pomBreak, setPomBreak] = usePersistedState("settings_pom_break", 5);
  const [abandonOn, setAbandonOn] = usePersistedState("settings_abandon_on", false);
  const [abandonMin, setAbandonMin] = usePersistedState("settings_abandon_min", 15);

  // 뽀모도로 사이클 상태 — timerState="running"이고 pomodoroOn=true일 때만 의미
  // pomPhase: 지금 집중 중인지 휴식 중인지. pomPhaseSec: 현재 phase에서 흐른 초.
  // 휴식 중일 때는 timerSec/Supabase focus 세션 모두 정지, phase만 카운트업.
  const [pomPhase, setPomPhase] = useState<"focus" | "break">("focus");
  const [pomPhaseSec, setPomPhaseSec] = useState(0);

  // 뽀모도로 or 방치 알림 켤 때 알림 권한 요청 — 이미 허용돼 있으면 no-op
  useEffect(() => {
    if (!pomodoroOn && !abandonOn) return;
    (async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch (e) { console.error(e); }
    })();
  }, [pomodoroOn, abandonOn]);

  // 뽀모도로가 켜진 채 휴식 phase에 진입해 있으면 currentSessionIdRef=null(집중 세션 종료됨).
  // 이 상태에서 사용자가 뽀모도로를 끄면 tick effect는 timerSec를 다시 증가시키지만 열린
  // DB 세션이 없어서 그 시간이 재시작 후 완전히 사라지는 데이터 유실 버그가 있었음.
  // pom을 끄는 순간 focus로 되돌리고 새 세션을 시작해 시간이 계속 기록되게 함.
  useEffect(() => {
    if (pomodoroOn) return;
    if (timerState !== "running") return;
    if (pomPhase !== "break") return;
    setPomPhase("focus");
    setPomPhaseSec(0);
    if (!currentSessionIdRef.current && !timerActionBusyRef.current) {
      (async () => {
        try {
          const session = await startTimerSession(TODAY_STR);
          currentSessionIdRef.current = session.id;
          setSessions(s => [...s, session]);
        } catch (e) { notifyError("타이머 세션 시작 실패")(e); }
      })();
    }
  }, [pomodoroOn, timerState, pomPhase]);

  // 방치 알림 — 타이머가 수동 정지된 상태(stopped)로 abandonMin분 유지되면 1회 알림.
  // running/auto-paused로 전환되면 취소, 다시 stopped로 진입할 때마다 새로 카운트 시작.
  useEffect(() => {
    if (!abandonOn) return;
    if (timerState !== "stopped") return;
    const id = window.setTimeout(async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) return;
        sendNotification({ title: "타이머가 멈춰 있습니다", body: `${abandonMin}분 동안 아무 활동도 없습니다. 다시 시작하시겠습니까?` });
      } catch (e) { console.error(e); }
    }, abandonMin * 60 * 1000);
    return () => window.clearTimeout(id);
  }, [abandonOn, abandonMin, timerState]);

  useEffect(() => {
    (async () => {
      try {
        let today = await fetchTodaySessions(TODAY_STR);
        // 지난번에 탭이 그냥 닫혀서 정상 종료 못 한 세션(ongoing)이 있으면 지금 시점으로 마감 처리
        const stale = today.filter(s => s.endReason === "ongoing");
        for (const s of stale) {
          await endTimerSession(s.id, "auto");
        }
        if (stale.length) today = await fetchTodaySessions(TODAY_STR);
        setSessions(today);
        const totalSec = today.reduce((sum, s) => {
          if (!s.endedAt) return sum;
          return sum + Math.max(0, Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000));
        }, 0);
        setTimerSec(totalSec);
        // 과거 날짜별 집중 시간 집계 로드
        setFocusSecByDate(await fetchFocusSecByDate());
      } catch (e) {
        // 조용히 삼키면 활동 기록 화면이 이유 없이 텅 비어 유저가 원인을 알 수 없음.
        notifyError("타이머 기록 불러오기 실패")(e);
      }
    })();
  }, []);

  // 재진입 가드 — 시작/정지 버튼을 rapid-click하거나 메인창/뜬창에서 같은 액션이
  // 동시에 들어오면 startTimerSession/endTimerSession이 중복 발화해 orphan 세션이
  // 남거나 currentSessionIdRef를 덮어써 첫 세션을 영구히 놓치는 버그가 있었음.
  // React setState는 배치되므로 setTimerState 직후에도 다음 호출은 여전히 이전 값을
  // 보므로, 동기적으로 검사 가능한 ref 게이트로 in-flight를 잠금.
  const timerActionBusyRef = useRef(false);

  const startSession = async () => {
    if (timerActionBusyRef.current) return;
    if (timerState === "running") return;
    timerActionBusyRef.current = true;
    setTimerState("running");
    setPomPhase("focus");
    setPomPhaseSec(0);
    try {
      const session = await startTimerSession(TODAY_STR);
      currentSessionIdRef.current = session.id;
      setSessions(s => [...s, session]);
    } catch (e) {
      // DB 실패를 조용히 삼키면 timerState는 running인데 currentSessionIdRef는 null이라
      // 유저는 타이머가 도는 것처럼 보이지만 실제 집중 시간이 기록되지 않는 데이터 유실이
      // 발생함. 상태를 되돌리고 사용자에게 알림.
      setTimerState("stopped");
      notifyError("타이머 시작 실패")(e);
    }
    finally { timerActionBusyRef.current = false; }
  };

  const endSession = async (reason: "manual" | "auto") => {
    if (timerActionBusyRef.current) return;
    // running/auto-paused 이외 상태에서 온 정지 요청은 무시(이미 stopped라면 no-op).
    if (timerState !== "running" && timerState !== "auto-paused") return;
    timerActionBusyRef.current = true;
    setTimerState(reason === "manual" ? "stopped" : "auto-paused");
    setPomPhase("focus");
    setPomPhaseSec(0);
    const sid = currentSessionIdRef.current;
    currentSessionIdRef.current = null;
    if (!sid) { timerActionBusyRef.current = false; return; }
    try {
      await endTimerSession(sid, reason);
      setSessions(s => s.map(x => x.id === sid ? { ...x, endedAt: new Date().toISOString(), endReason: reason } : x));
    } catch (e) {
      // 세션이 DB에서 'ongoing' 상태로 남게 되지만 다음 앱 시작 시 stale 정리가 자동으로
      // 마감해줌. 사용자에게는 알림만 표시.
      notifyError("타이머 정지 저장 실패")(e);
    }
    finally { timerActionBusyRef.current = false; }
  };

  // 오늘 타이머 기록을 통째로 초기화 — 실행 중이면 먼저 정지시키고, Supabase의 오늘 세션들도
  // 전부 지움. 사용자가 히스토리 팝오버 안의 "초기화" 버튼을 누를 때만 트리거됨.
  const resetTodayTimer = async () => {
    setTimerState("stopped");
    setPomPhase("focus");
    setPomPhaseSec(0);
    currentSessionIdRef.current = null;
    setSessions([]);
    setTimerSec(0);
    try {
      await deleteTodaySessions(TODAY_STR);
    } catch (e) {
      // 조용히 삼키면 로컬 UI는 초기화된 것처럼 보이지만 DB에는 오늘 세션이 그대로 남아
      // 다음 실행 시 되살아남. 사용자에게 알려서 재시도 유도.
      notifyError("타이머 기록 초기화 실패")(e);
    }
  };

  // 타이머 시작/정지는 오직 사용자가 버튼을 눌러서만 발생 — 창 포커스 등 자동 트리거 없음
  // (예전에는 창 포커스 이탈 시 자동 일시정지했지만 의도치 않게 끊기는 문제로 비활성화)

  // 뜬 타이머 창(별도 webview) 상태 훅을 여기서 관리 — GlobalTimer 내부에서 관리하면
  // 아래 브로드캐스트 effect가 창 오픈 여부를 알 수 없어 항상 매초 emit해야 했음.
  // 이제 창이 닫혀 있을 때는 emit 자체를 스킵.
  const floatWin = useTimerWindow();

  // 뜬 타이머 창(별도 webview)과의 상태 동기화 — 창이 열려 있을 때만 매초 브로드캐스트.
  useEffect(() => {
    if (!floatWin.isOpen) return;
    const pomPhaseRemainSec = Math.max(0, (pomPhase === "focus" ? pomWork : pomBreak) * 60 - pomPhaseSec);
    emit("timer:state", { timerState, timerSec, pomodoroOn, pomPhase, pomPhaseRemainSec });
  }, [floatWin.isOpen, timerState, timerSec, pomodoroOn, pomPhase, pomPhaseSec, pomWork, pomBreak]);

  // 뜬 타이머 창에서 온 시작/정지 요청 처리 — DB 쓰기는 항상 이 메인 창에서만 발생.
  //
  // 반드시 ref로 최신 startSession/endSession을 참조해야 함.
  // 예전엔 listen 콜백 안에서 startSession/endSession을 직접 호출했는데, 이 effect의 deps가
  // []라 마운트 시점의 함수(=마운트 시점의 timerState="stopped"를 클로저로 캡처)가 영구히
  // 잡혀 있었음. 결과적으로:
  //  - 뜬 창의 정지 버튼: endSession 안의 `if (timerState !== "running" && ...) return;`가
  //    캡처된 "stopped"를 보고 항상 early return → 정지 자체가 안 됨.
  //  - 뜬 창의 시작 버튼: 이미 running 상태여도 startSession의 `if (timerState === "running") return;`
  //    가드가 캡처된 "stopped"를 보고 통과 → 중복 세션 생성 가능.
  const startSessionRef = useRef<(() => void) | undefined>(undefined);
  const endSessionRef = useRef<((reason: "manual" | "auto") => void) | undefined>(undefined);
  startSessionRef.current = startSession;
  endSessionRef.current = endSession;
  useEffect(() => {
    const unlisten = listen<{ type: "start" | "stop" }>("timer:action", (e) => {
      if (e.payload.type === "start") startSessionRef.current?.();
      else endSessionRef.current?.("manual");
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 자정 롤오버 — 탭을 안 닫고 자정을 넘기면 TODAY_STR이 그대로 어제로 남아있던 버그.
  // 30초마다 실제 날짜와 비교해서, 바뀌었으면 (1) 실행 중이던 세션을 어제 날짜로 마감하고
  // 실행 중이었다면 오늘 날짜로 새 세션을 이어서 시작 (2) 오늘의 세션/누적시간을 새로 불러옴
  // (3) dayTick을 올려서 TODAY_STR을 직접 참조하는 모든 컴포넌트를 리렌더시킴.
  //
  // deps는 빈 배열 — 예전엔 [timerState]라 시작/정지할 때마다 30초 인터벌이 재시작돼서
  // 자정 근처에 시작/정지가 잦으면 최악 30초 지연 가능성이 있었음. 인터벌은 마운트 시
  // 한 번만 걸고, 콜백 안에서 필요한 값(timerState)은 ref로 읽음.
  const [, setDayTick] = useState(0);
  const timerStateRef = useRef(timerState);
  useEffect(() => { timerStateRef.current = timerState; }, [timerState]);
  useEffect(() => {
    const id = setInterval(async () => {
      if (!syncTodayIfChanged()) return;
      const wasRunning = timerStateRef.current === "running";
      const sid = currentSessionIdRef.current;
      currentSessionIdRef.current = null;
      try {
        if (sid) await endTimerSession(sid, "auto");
        if (wasRunning) {
          const session = await startTimerSession(TODAY_STR);
          currentSessionIdRef.current = session.id;
          setSessions([session]);
        } else {
          setSessions(await fetchTodaySessions(TODAY_STR));
        }
        setTimerSec(0);
        // 어제 세션이 방금 마감돼 어제 집중 시간이 확정됐으니 히트맵 값도 갱신
        setFocusSecByDate(await fetchFocusSecByDate());
      } catch (e) {
        // 자정 롤오버 중 DB 오류가 나면 세션이 날짜 경계에 걸린 채 남고 집중 통계가
        // 어긋나므로 사용자에게 알림.
        notifyError("자정 롤오버 처리 실패")(e);
      }
      setDayTick(t => t + 1);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Calendar UI state
  const [calView, setCalView] = useState<"day" | "week" | "month">("week");
  const [templateOpen, setTemplateOpen] = useState(true);

  useEffect(() => {
    if (timerState !== "running") return;
    const id = setInterval(() => {
      // 뽀모도로 휴식 중이면 누적 집중 시간(timerSec)은 늘리지 않고 phase 시간만 늘림
      if (pomodoroOn && pomPhase === "break") {
        setPomPhaseSec(s => s + 1);
      } else {
        setTimerSec(s => s + 1);
        if (pomodoroOn) setPomPhaseSec(s => s + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timerState, pomodoroOn, pomPhase]);

  // 뽀모도로 phase 전환 — 집중이 pomWork분 지나면 자동으로 휴식, 휴식이 pomBreak분 지나면
  // 자동으로 다시 집중. 집중 종료 시 Supabase focus 세션 마감, 휴식 종료 시 새 세션 시작.
  //
  // 재진입 가드(pomTransitionBusyRef): endTimerSession/startTimerSession이 1초를 넘기면
  // 그 사이 tick effect가 pomPhaseSec를 target+1로 밀어 이 effect가 재발화 → 같은 phase에서
  // 두 번 마감/시작해 orphan 세션이 생기던 문제. React setState는 배치돼서 setPomPhase(0) 직전에
  // 재실행되면 여전히 이전 phase/pomPhaseSec를 보므로 ref로 동기 게이트.
  const pomTransitionBusyRef = useRef(false);
  useEffect(() => {
    if (!pomodoroOn || timerState !== "running") return;
    const targetSec = (pomPhase === "focus" ? pomWork : pomBreak) * 60;
    if (pomPhaseSec < targetSec) return;
    if (pomTransitionBusyRef.current) return;
    pomTransitionBusyRef.current = true;

    (async () => {
      try {
        if (pomPhase === "focus") {
          const sid = currentSessionIdRef.current;
          currentSessionIdRef.current = null;
          if (sid) {
            try {
              // 뽀모도로 자동 phase 전환은 사용자 수동 정지가 아니므로 "auto"로 마감.
              // (히스토리 팝오버가 "manual"(■)로 표시하던 semantic 어긋남을 바로잡음)
              await endTimerSession(sid, "auto");
              setSessions(s => s.map(x => x.id === sid ? { ...x, endedAt: new Date().toISOString(), endReason: "auto" } : x));
            } catch (e) {
              // 예전엔 console.error만 남기고 넘어가서, 세션이 "ongoing"으로 남은 채 다음 실행 때
              // 뒤늦게 정리되며 오늘/다음 시작일의 집중 시간이 몇 시간씩 부풀어 보이던 문제.
              notifyError("집중 세션 마감 실패")(e);
            }
          }
          setPomPhase("break");
          setPomPhaseSec(0);
          notifyPomodoro("집중 완료", `${pomBreak}분 쉽니다`);
        } else {
          try {
            const session = await startTimerSession(TODAY_STR);
            currentSessionIdRef.current = session.id;
            setSessions(s => [...s, session]);
          } catch (e) { notifyError("휴식 후 세션 시작 실패")(e); }
          setPomPhase("focus");
          setPomPhaseSec(0);
          notifyPomodoro("휴식 완료", `다시 ${pomWork}분 집중합니다`);
        }
      } finally {
        pomTransitionBusyRef.current = false;
      }
    })();
  }, [pomPhaseSec, pomPhase, pomodoroOn, timerState, pomWork, pomBreak]);

  const toggleBlock = (id: string) => {
    const target = blocks.find(b => b.id === id);
    if (!target) return;
    const completed = !target.completed;
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, completed } : b));
    patchBlock(id, { completed }).catch(notifyError("완료 상태 저장 실패"));
  };

  // Optimistic insert: shows instantly with a temp id, then swapped for the real DB row.
  // openInline은 캘린더 클릭으로 만든 이름 없는 블록 — 상세 패널을 곧바로 띄우고 제목 편집에
  // 포커스를 줌. 사이드바 템플릿 자동 등록은 하지 않음(사용자 요청): 캘린더에서 그린 블록은
  // 그날 그 자리에만 쓰이는 일회성이 대부분이라, 매번 사이드바에 "새 블록"류 템플릿이
  // 쌓이면 오히려 지저분해짐. 재사용이 필요하면 사이드바의 "+ 새 템플릿"으로 명시적으로 등록.
  // 이 경로에선 낙관적 temp id 없이 DB 저장을 기다렸다가 진짜 id로 시작 — 안 그러면 temp→real
  // 스왑 시 상세 패널(key={id})이 리마운트되며 사용자가 입력 중이던 제목이 날아감.
  const addBlock = (block: Block, options?: { select?: boolean; openInline?: boolean }, retryLeft = 5) => {
    // 부모 블록/템플릿이 아직 낙관적 temp-id 상태라면 parent_block_id / template_id FK 컬럼에
    // temp-id를 그대로 저장하려다 FK 활성화 후 "블록 추가 실패" 로 실패함. 부모/템플릿이 DB에
    // 실 등록될 때까지 잠깐 미뤄서 재시도 — 스왑 후 통과. retryLeft 로 무한 루프 방지.
    const pendingParent = block.parentBlockId?.startsWith("temp-");
    const pendingTemplate = block.templateId?.startsWith("temp-");
    if (pendingParent || pendingTemplate) {
      if (retryLeft <= 0) {
        const reason = pendingParent
          ? "부모 블록 저장이 완료되지 않아 자식 블록을 만들 수 없습니다"
          : "템플릿 저장이 완료되지 않아 이 블록을 만들 수 없습니다";
        notifyError("블록 추가 실패")(new Error(reason));
        return;
      }
      setTimeout(() => addBlock(block, options, retryLeft - 1), 200);
      return;
    }
    if (options?.select || options?.openInline) {
      insertBlock(block)
        .then(real => {
          setBlocks(bs => [...bs, real]);
          openBlockDetail(real);
          if (options.openInline) setJustCreatedBlockId(real.id);
        })
        .catch(notifyError("블록 추가 실패"));
      return;
    }
    // 밀리초가 같은 프레임에 두 번 클릭이 들어오면 Date.now() 만으론 tempId가 충돌해서
     // 두 번째 낙관적 로우가 첫 번째 real 로우로 통째로 덮어씌워지고, DB엔 두 건이지만 화면엔
     // 한 건만 보이는 유령 상태가 나옴. randomUUID로 충돌을 원천 차단.
    const tempId = `temp-${crypto.randomUUID()}`;
    setBlocks(bs => [...bs, { ...block, id: tempId }]);
    insertBlock(block)
      .then(real => {
        setBlocks(bs => bs.map(b => (b.id === tempId ? real : b)));
        // 사용자가 낙관적 삽입 직후 그 블록을 클릭해 selectedBlock 이 temp-id 로 남아 있으면,
        // 이후 patchBlock(temp-id) 는 UPDATE 0 rows 로 조용히 사라지고 checklist_items 등
        // FK 컬럼에 temp-id 를 저장하려는 시도는 FK 위반으로 실패함. 스왑을 selectedBlock 에도 반영.
        setSelectedBlock(prev => (prev?.id === tempId ? real : prev));
      })
      .catch(e => { setBlocks(bs => bs.filter(b => b.id !== tempId)); notifyError("블록 추가 실패")(e); });
  };

  // Local-only update — used for high-frequency visual feedback (e.g. resize drag) where
  // hitting the DB on every mousemove would be wasteful. Persisted separately on drag-end.
  const updateBlockLocal = (id: string, changes: Partial<Block>) =>
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, ...changes } : b));

  const updateBlock = (id: string, changes: Partial<Block>) => {
    updateBlockLocal(id, changes);
    patchBlock(id, changes).catch(notifyError("블록 저장 실패"));
  };

  const deleteBlock = (id: string) => {
    // FK 활성화 후에는 parent_block_id ON DELETE CASCADE 로 자식 블록이 DB에서도 함께 지워짐.
    // 로컬 상태만 부모를 제거하면 자식은 유령으로 남아 다음 refetch 전까지 이상하게 보일 수 있어
    // 로컬 상태에서도 함께 정리. 자식의 자식까지 재귀로 훑음.
    // 삭제 직전 상태를 캡처해 Ctrl+Z 로 복구 가능하게 함. FK 있는 필드는 배제하고 재삽입.
    const snapshot = blocksRefTop.current.find(b => b.id === id);
    setBlocks(bs => {
      const toDelete = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const b of bs) {
          if (b.parentBlockId && toDelete.has(b.parentBlockId) && !toDelete.has(b.id)) {
            toDelete.add(b.id);
            grew = true;
          }
        }
      }
      return bs.filter(b => !toDelete.has(b.id));
    });
    setSelectedBlock(prev => prev?.id === id ? null : prev);
    deleteBlockRow(id).catch(notifyError("블록 삭제 실패"));
    if (snapshot) {
      pushUndo(async () => {
        try {
          const restored = await insertBlock({ ...snapshot, parentBlockId: undefined, nextBlockId: undefined, templateId: undefined });
          setBlocks(bs => [...bs, restored]);
        } catch (e) { notifyError("복구 실패")(e); }
      });
    }
  };

  // 최신 blocks 스냅샷을 콜백 클로저 안에서 안정적으로 읽기 위한 ref. 벌크 op(붙여넣기,
  // 다중 이동, 다중 반복 등)은 사용자 액션 시점의 최신 상태를 봐야 겹침 체크나 undo 캡처가
  // 정확해짐. 매 render 시 갱신되므로 stale closure 문제 없음.
  const blocksRefTop = useRef<Block[]>([]);
  useEffect(() => { blocksRefTop.current = blocks; }, [blocks]);

  const overlapsBlock = (bs: Block[], date: string, sMin: number, eMin: number, excludeIds?: Set<string>) =>
    bs.some(x =>
      !x.parentBlockId && x.date === date && !(excludeIds?.has(x.id)) &&
      sMin < x.endH * 60 + x.endM && eMin > x.startH * 60 + x.startM
    );

  // 다중 이동 — 캘린더에서 여러 블록 선택 후 드래그 시 사용. 각 블록의 (date, startMin) 을
  // 전달하고, 겹침이 있는 블록은 스킵. 실행 취소 스택엔 이 이동을 통째로 롤백하는 함수 하나 push.
  const bulkMoveBlocks = async (moves: Array<{ id: string; newDate: string; newStartMin: number }>) => {
    const current = blocksRefTop.current;
    const movingIds = new Set(moves.map(m => m.id));
    const prevMap = new Map(current.filter(b => movingIds.has(b.id)).map(b => [b.id, b] as const));

    // 이동 후 상태를 미리 계산해서 자체 겹침(선택된 블록끼리)도 검사
    const projected: Array<{ id: string; date: string; sMin: number; eMin: number }> = [];
    const applied: Array<{ id: string; changes: Partial<Block>; prev: Partial<Block> }> = [];
    for (const m of moves) {
      const prev = prevMap.get(m.id);
      if (!prev) continue;
      const dur = (prev.endH * 60 + prev.endM) - (prev.startH * 60 + prev.startM);
      const sMin = Math.max(0, Math.min(24 * 60 - dur, m.newStartMin));
      const eMin = sMin + dur;
      // 이 무브 뿐 아니라 이미 planned 된 다른 무브들과도 안 겹치는지 함께 검사
      const overlapWithOthers = projected.some(p => p.date === m.newDate && sMin < p.eMin && eMin > p.sMin);
      if (overlapWithOthers) continue;
      // 이동 대상이 아닌 기존 블록과의 겹침 검사
      if (overlapsBlock(current, m.newDate, sMin, eMin, movingIds)) continue;
      projected.push({ id: m.id, date: m.newDate, sMin, eMin });
      applied.push({
        id: m.id,
        changes: { date: m.newDate, startH: Math.floor(sMin / 60), startM: sMin % 60, endH: Math.floor(eMin / 60), endM: eMin % 60 },
        prev: { date: prev.date, startH: prev.startH, startM: prev.startM, endH: prev.endH, endM: prev.endM },
      });
    }
    if (applied.length === 0) return;
    // 로컬 상태 낙관적 적용
    setBlocks(bs => bs.map(b => {
      const a = applied.find(x => x.id === b.id);
      return a ? { ...b, ...a.changes } : b;
    }));
    // DB 반영 — 각각 개별 patch (BEGIN/COMMIT은 pool 문제로 제거된 상태)
    for (const a of applied) {
      patchBlock(a.id, a.changes).catch(notifyError("블록 저장 실패"));
    }
    // 실행 취소: 원래 위치로 되돌림
    pushUndo(async () => {
      setBlocks(bs => bs.map(b => {
        const a = applied.find(x => x.id === b.id);
        return a ? { ...b, ...a.prev } : b;
      }));
      for (const a of applied) {
        try { await patchBlock(a.id, a.prev); } catch (e) { notifyError("블록 저장 실패")(e); }
      }
    });
  };

  // Ctrl+V 붙여넣기 — 클립보드에 담긴 블록들을 targetDate 기준으로 상대 날짜 유지하며 복제.
  // 겹치는 시간대는 스킵. 실행 취소는 붙여넣은 블록 전체를 삭제하는 함수 하나 push.
  const pasteBlocks = async (source: Block[], targetDate: string) => {
    if (source.length === 0) return;
    const dates = source.map(b => b.date).sort();
    const earliest = parseLocalDate(dates[0]);
    const target = parseLocalDate(targetDate);
    const offsetDays = Math.round((target.getTime() - earliest.getTime()) / 86400000);

    const candidates: Block[] = source.map(b => {
      const d = parseLocalDate(b.date);
      d.setDate(d.getDate() + offsetDays);
      return {
        ...b,
        id: `paste-${crypto.randomUUID()}`,
        date: toDateStr(d),
        completed: false,
        // 붙여넣기는 원본과의 연결 관계는 잘라내고 순수 복제만
        repeat: undefined,
        repeatGroupId: undefined,
        parentBlockId: undefined,
        nextBlockId: undefined,
        templateId: undefined,
      };
    });

    // 겹침이 있어도 자동 이동/차단/알림 없이 원래 시간 그대로 삽입 — 사용자가 원하는
    // 대로 그냥 붙여넣기. 겹친 블록은 캘린더에서 시각적으로 겹쳐 보이며 드래그로 정리 가능.
    try {
      const real = await insertBlocksBulk(candidates);
      setBlocks(bs => [...bs, ...real]);
      const ids = real.map(b => b.id);
      pushUndo(
        async () => {
          setBlocks(bs => bs.filter(b => !ids.includes(b.id)));
          for (const id of ids) { try { await deleteBlockRow(id); } catch {} }
        },
        async () => {
          try {
            const restored = await insertBlocksBulk(real);
            setBlocks(bs => [...bs, ...restored]);
          } catch (e) { notifyError("붙여넣기 다시 실행 실패")(e); }
        },
      );
    } catch (e) { notifyError("붙여넣기 실패")(e); }
  };

  // 다중 삭제 — 우클릭 메뉴 등에서 사용. 실행 취소로 재삽입.
  const bulkDeleteBlocks = async (ids: string[]) => {
    if (ids.length === 0) return;
    const current = blocksRefTop.current;
    const targets = current.filter(b => ids.includes(b.id));
    if (targets.length === 0) return;
    setBlocks(bs => bs.filter(b => !ids.includes(b.id)));
    setSelectedBlock(prev => (prev && ids.includes(prev.id) ? null : prev));
    for (const id of ids) { deleteBlockRow(id).catch(notifyError("블록 삭제 실패")); }
    // 실행 취소: 원래 블록들 다시 insert. FK 없는 필드만 복원(연결/부모 관계는 컴플렉스라 생략).
    pushUndo(async () => {
      try {
        const restored = await insertBlocksBulk(targets.map(t => ({ ...t, parentBlockId: undefined, nextBlockId: undefined, templateId: undefined })));
        setBlocks(bs => [...bs, ...restored]);
      } catch (e) { notifyError("복구 실패")(e); }
    });
  };

  // 여러 블록에 동일 반복 규칙 적용 — 우클릭 → 반복 설정. 각 블록에 대해 setBlockRepeat 호출.
  const bulkSetRepeatForBlocks = (ids: string[], repeat: BlockRepeat) => {
    for (const id of ids) setBlockRepeat(id, repeat);
  };

  // UI 진입점에서 호출하는 삭제 래퍼 — 반복 그룹 소속이면 모달로 범위(단건/이후 전체) 를 물어보고,
  // 아니면 곧바로 단건 삭제. 반복 블록을 무심코 삭제해 그룹 전체가 사라지거나(반대로) 하나만
  // 남는 걸 막기 위해 모든 UI 삭제 버튼은 이 함수를 통해 흐르게 함.
  const requestDeleteBlock = (id: string) => {
    const block = blocksRefTop.current.find(b => b.id === id) ?? blocks.find(b => b.id === id);
    if (!block) return;
    if (block.repeatGroupId) {
      setRepeatDeletePrompt({ id, date: block.date, title: block.title });
    } else {
      deleteBlock(id);
    }
  };

  const deleteRepeatGroup = (id: string, fromDate: string) => {
    const block = blocks.find(b => b.id === id);
    const groupId = block?.repeatGroupId;
    // 반복 그룹에서 지운 블록의 자식(parent_block_id=반복 인스턴스)도 FK CASCADE로 DB에선
    // 함께 사라짐. 로컬 상태에서도 재귀로 훑어 함께 지워줘야 다음 refetch 전까지 유령 자식이
    // 남지 않음. 단일 블록 삭제 시 deleteBlock에서 한 것과 같은 fixed-point 방식.
    setBlocks(bs => {
      const toDelete = new Set<string>();
      if (!groupId) {
        toDelete.add(id);
      } else {
        for (const b of bs) {
          if (b.repeatGroupId === groupId && b.date >= fromDate) toDelete.add(b.id);
        }
      }
      let grew = true;
      while (grew) {
        grew = false;
        for (const b of bs) {
          if (b.parentBlockId && toDelete.has(b.parentBlockId) && !toDelete.has(b.id)) {
            toDelete.add(b.id);
            grew = true;
          }
        }
      }
      return bs.filter(b => !toDelete.has(b.id));
    });
    if (!groupId) {
      deleteBlockRow(id).catch(notifyError("블록 삭제 실패"));
    } else {
      apiDeleteRepeatGroup(groupId, fromDate).catch(notifyError("반복 블록 삭제 실패"));
    }
    setSelectedBlock(null);
  };

  // 반복 규칙이 만들어내는 미래 날짜 목록(원본 날짜 제외) — 블록/할 일이 공유.
  // 종료 조건별 상한:
  //  - count: 요청한 횟수를 정확히 채우도록 (monthly/yearly 는 없는 날짜를 건너뛰므로 여유분 포함)
  //  - date : 종료 날짜까지 실제 커버할 수 있도록 상한 크게(내부 early break가 종료일에서 끊음)
  //  - none : 앞으로 보여줄 기본 롤링 윈도우(daily 14일 / weekly 8주 / monthly 12개월 / yearly 5년)
  const generateRepeatDates = (originStr: string, repeat: BlockRepeat): string[] => {
    const origin = parseLocalDate(originStr);
    const dates: string[] = [];
    const wantCount = repeat.endType === "count" ? repeat.endCount : Infinity;
    const overEnd = (ds: string) => repeat.endType === "date" && ds > repeat.endDate;
    if (repeat.type === "daily") {
      const maxDays = repeat.endType === "count" ? repeat.endCount : repeat.endType === "date" ? 365 : 14;
      for (let i = 1; i <= maxDays && dates.length < wantCount; i++) {
        const d = new Date(origin); d.setDate(origin.getDate() + i);
        const ds = toDateStr(d);
        if (overEnd(ds)) break;
        dates.push(ds);
      }
    } else if (repeat.type === "weekly") {
      const daysPerWeek = Math.max(1, repeat.days.length);
      const maxWeeks = repeat.endType === "count"
        ? Math.ceil(repeat.endCount / daysPerWeek)
        : repeat.endType === "date" ? 53 : 8;
      for (let week = 1; week <= maxWeeks; week++) {
        for (const day of repeat.days.slice().sort()) {
          if (dates.length >= wantCount) return dates;
          const d = new Date(origin);
          const diff = (day - origin.getDay() + 7) % 7 || 7;
          d.setDate(origin.getDate() + diff + (week - 1) * 7);
          const ds = toDateStr(d);
          if (overEnd(ds)) return dates;
          dates.push(ds);
        }
      }
    } else if (repeat.type === "monthly") {
      // 매달 같은 일(day-of-month). 그 일이 없는 달(예: 31일 → 2월)은 건너뜀 —
      // Date 가 자동 롤오버하면 getDate() 가 달라지는 것으로 감지.
      const maxMonths = repeat.endType === "count" ? repeat.endCount * 2 + 12 : repeat.endType === "date" ? 120 : 12;
      for (let i = 1; i <= maxMonths && dates.length < wantCount; i++) {
        const d = new Date(origin.getFullYear(), origin.getMonth() + i, origin.getDate());
        if (d.getDate() !== origin.getDate()) continue;
        const ds = toDateStr(d);
        if (overEnd(ds)) break;
        dates.push(ds);
      }
    } else {
      // yearly — 매년 같은 월/일. 2/29 는 윤년에만 생성.
      const maxYears = repeat.endType === "count" ? repeat.endCount * 4 + 8 : repeat.endType === "date" ? 100 : 5;
      for (let i = 1; i <= maxYears && dates.length < wantCount; i++) {
        const d = new Date(origin.getFullYear() + i, origin.getMonth(), origin.getDate());
        if (d.getDate() !== origin.getDate()) continue;
        const ds = toDateStr(d);
        if (overEnd(ds)) break;
        dates.push(ds);
      }
    }
    return dates;
  };

  // Generate repeat instances for a block.
  const generateRepeatInstances = (block: Block, repeat: BlockRepeat): Block[] => {
    const groupId = block.repeatGroupId || `rg-${block.id}`;
    return generateRepeatDates(block.date, repeat).map(dateStr => ({
      ...block, id: `b-${crypto.randomUUID()}`,
      date: dateStr, completed: false,
      repeatGroupId: groupId, repeat,
    }));
  };

  const refetchBlocks = async () => {
    // 예전엔 실패해도 console에만 남겨서, setBlockRepeat 등 mutation 성공 후 refetch가 실패하면
    // 화면엔 낙관적 temp 인스턴스가 유령처럼 남아 사용자가 원인도 모른 채 지우지도 편집하지도
    // 못하는 상태가 됨.
    try { setBlocks(await fetchBlocks()); } catch (e) { notifyError("블록 새로고침 실패")(e); }
  };

  const setBlockRepeat = (id: string, repeat: BlockRepeat) => {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    const groupId = `rg-${id}`;
    const updated = { ...block, repeat, repeatGroupId: groupId };
    const instances = generateRepeatInstances(updated, repeat);

    // optimistic: show immediately with temp ids, then reconcile against the DB
    setBlocks(bs => {
      const filtered = bs.filter(b => b.repeatGroupId !== groupId || b.id === id);
      return [...filtered.map(b => (b.id === id ? updated : b)), ...instances];
    });

    (async () => {
      try {
        await patchBlock(id, { repeat, repeatGroupId: groupId });
        // 재저장 시 이전 규칙으로 만든 인스턴스가 DB에 남아있으면 새/구가 섞이므로 먼저 정리.
        // origin은 유지하고 그룹의 나머지만 삭제한 뒤 새 인스턴스를 insert.
        await deleteRepeatInstancesExceptOrigin(groupId, id);
        if (instances.length) await insertBlocksBulk(instances);
        await refetchBlocks();
      } catch (e) {
        // 조용히 삼키면 patchBlock만 성공하고 insertBlocksBulk가 실패한 경우 원본에는
        // 반복 규칙이 저장됐지만 인스턴스는 생성되지 않아 사용자가 이유를 알기 어려움.
        notifyError("반복 저장 실패")(e);
        // 낙관적으로 추가한 temp instance들이 로컬 상태에 유령 블록으로 남지 않도록 DB와 동기화.
        try { await refetchBlocks(); } catch {}
      }
    })();
  };

  const toggleDeadline = (id: string) => {
    const target = deadlines.find(d => d.id === id);
    if (!target) return;
    const completed = !target.completed;
    setDeadlines(ds => ds.map(d => d.id === id ? { ...d, completed } : d));
    toggleDeadlineRow(id, completed).catch(notifyError("마감 저장 실패"));
  };

  const deleteDeadline = (id: string) => {
    setDeadlines(ds => ds.filter(d => d.id !== id));
    deleteDeadlineRow(id).catch(notifyError("마감 삭제 실패"));
  };

  // 상세 패널에서 제목/마감일/색상 변경 시 호출 — 낙관적 업데이트 후 DB 저장.
  const updateDeadline = (id: string, changes: { title?: string; dueDate?: string; color?: string }) => {
    setDeadlines(ds => ds.map(d => d.id === id ? { ...d, ...changes } : d));
    updateDeadlineRow(id, changes).catch(notifyError("마감 저장 실패"));
  };

  const addTemplate = (t: { title: string; color: string; tags: string[]; kind?: "time" | "todo" }) => {
    // 밀리초가 같은 프레임에 두 번 클릭이 들어오면 Date.now() 만으론 tempId가 충돌해서
     // 두 번째 낙관적 로우가 첫 번째 real 로우로 통째로 덮어씌워지고, DB엔 두 건이지만 화면엔
     // 한 건만 보이는 유령 상태가 나옴. randomUUID로 충돌을 원천 차단.
    const tempId = `temp-${crypto.randomUUID()}`;
    const kind: "time" | "todo" = t.kind === "todo" ? "todo" : "time";
    setTemplates(ts => [...ts, { id: tempId, title: t.title, color: t.color, tags: t.tags, kind }]);
    createTemplate({ ...t, kind })
      .then(real => setTemplates(ts => ts.map(x => (x.id === tempId ? real : x))))
      .catch(e => { setTemplates(ts => ts.filter(x => x.id !== tempId)); notifyError("템플릿 추가 실패")(e); });
  };

  // 템플릿 삭제 — 이미 이 템플릿으로 만들어진 블록은 그대로 두고 template_id만 NULL로 끊김.
  // kind='todo' (= 카테고리) 삭제 시엔 이름이 매칭되는 todos.category 를 빈 문자열(미분류)로
  // 이동. 색상은 렌더링 시 getCategoryColor 가 자동으로 미분류 톤으로 바꿔줌.
  const deleteTemplate = (id: string) => {
    const target = templates.find(x => x.id === id);
    setTemplates(ts => ts.filter(x => x.id !== id));
    setBlocks(bs => bs.map(b => b.templateId === id ? { ...b, templateId: undefined } : b));
    if (target?.kind === "todo") {
      const name = target.title;
      const orphaned = todos.filter(t => t.category === name);
      if (orphaned.length > 0) {
        setTodos(ts => ts.map(t => t.category === name ? { ...t, category: "" } : t));
        // DB 도 각각 UPDATE. 실패해도 UI 는 유지 — 다음 로드에서 정정됨.
        for (const t of orphaned) {
          updateTodo(t.id, { category: "" }).catch(() => {});
        }
      }
    }
    deleteTemplateRow(id).catch(notifyError("블록 템플릿 삭제 실패"));
  };

  const addDeadline = (d: { title: string; dueDate: string }) => {
    // 밀리초가 같은 프레임에 두 번 클릭이 들어오면 Date.now() 만으론 tempId가 충돌해서
     // 두 번째 낙관적 로우가 첫 번째 real 로우로 통째로 덮어씌워지고, DB엔 두 건이지만 화면엔
     // 한 건만 보이는 유령 상태가 나옴. randomUUID로 충돌을 원천 차단.
    const tempId = `temp-${crypto.randomUUID()}`;
    setDeadlines(ds => [...ds, { id: tempId, title: d.title, dueDate: d.dueDate, completed: false, color: "" }]);
    createDeadline(d)
      .then(real => setDeadlines(ds => ds.map(x => (x.id === tempId ? real : x))))
      .catch(e => { setDeadlines(ds => ds.filter(x => x.id !== tempId)); notifyError("마감 추가 실패")(e); });
  };

  // ── todos ─────────────────────────────────────────────────
  const addTodo = (
    t: { title: string; date: string; endDate?: string | null; color?: string; category?: string },
    options?: { openInline?: boolean },
  ) => {
    if (!t.title.trim()) return;
    // 같은 날짜의 기존 todo 중 최대 sort_order + 1 을 부여해 새 항목이 맨 아래로 붙게 함.
    const nextSort = Math.max(-1, ...todos.filter(x => x.date === t.date).map(x => x.sortOrder)) + 1;
    // todo.color 컬럼은 DB 스키마 호환용으로만 남고 렌더링은 카테고리 색을 조회함.
    // 여기서는 어떤 값이든 상관없지만 NOT NULL 이라 기본 색을 채워 둠.
    const color = t.color ?? "#5AA9E6";
    const category = t.category ?? "";
    // openInline 경로: 상세 패널을 곧바로 띄우고 제목을 편집 상태로 여는 게 목적.
    // 낙관적 temp id 로 열면 real id 로 스왑될 때 상세 패널(key={id})이 리마운트되며
    // 사용자가 입력하던 제목이 날아감 — 블록의 openInline 처리와 동일하게 DB 저장을 기다렸다가
    // 진짜 id 로 시작.
    if (options?.openInline) {
      createTodo(t)
        .then(real => {
          setTodos(ts => [...ts, { ...real, sortOrder: nextSort }]);
          openTodoDetail(real);
          setJustCreatedTodoId(real.id);
          if (nextSort !== 0) updateTodo(real.id, { sortOrder: nextSort }).catch(() => {});
        })
        .catch(notifyError("todo 추가 실패"));
      return;
    }
    const tempId = `temp-${crypto.randomUUID()}`;
    setTodos(ts => [...ts, { id: tempId, title: t.title, date: t.date, endDate: t.endDate ?? null, color, completed: false, memo: "", category, countInCompletion: true, sortOrder: nextSort }]);
    createTodo(t)
      .then(real => {
        setTodos(ts => ts.map(x => (x.id === tempId ? { ...real, sortOrder: nextSort } : x)));
        if (nextSort !== 0) {
          // DB 는 아직 sort_order=0 이므로 즉시 patch. 실패해도 UI 는 유지 — 다음 로드에서 정정됨.
          updateTodo(real.id, { sortOrder: nextSort }).catch(() => {});
        }
      })
      .catch(e => { setTodos(ts => ts.filter(x => x.id !== tempId)); notifyError("todo 추가 실패")(e); });
  };
  const toggleTodo = (id: string) => {
    const target = todos.find(t => t.id === id);
    if (!target) return;
    const nextCompleted = !target.completed;
    setTodos(ts => ts.map(t => t.id === id ? { ...t, completed: nextCompleted } : t));
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, completed: nextCompleted } : prev));
    toggleTodoRow(id, nextCompleted).catch(notifyError("todo 완료 저장 실패"));
  };
  const deleteTodo = (id: string) => {
    const snapshot = todos.find(t => t.id === id);
    setTodos(ts => ts.filter(t => t.id !== id));
    setSelectedTodo(prev => (prev?.id === id ? null : prev));
    deleteTodoRow(id).catch(notifyError("todo 삭제 실패"));
    if (snapshot) {
      pushUndo(async () => {
        try {
          const restored = await createTodo({ title: snapshot.title, date: snapshot.date, endDate: snapshot.endDate, color: snapshot.color, memo: snapshot.memo, category: snapshot.category, countInCompletion: snapshot.countInCompletion });
          setTodos(ts => [...ts, restored]);
        } catch (e) { notifyError("todo 복구 실패")(e); }
      });
    }
  };

  // UI 진입점에서 호출하는 삭제 래퍼 — 반복 그룹 소속이면 모달로 범위(단건/이후 전체) 를 물어보고,
  // 아니면 곧바로 단건 삭제. requestDeleteBlock 의 todo 대응.
  const requestDeleteTodo = (id: string) => {
    const todo = todos.find(t => t.id === id);
    if (!todo) return;
    if (todo.repeatGroupId) {
      setTodoRepeatDeletePrompt({ id, date: todo.date, title: todo.title });
    } else {
      deleteTodo(id);
    }
  };

  const deleteTodoRepeatGroup = (id: string, fromDate: string) => {
    const todo = todos.find(t => t.id === id);
    const groupId = todo?.repeatGroupId;
    setTodos(ts => {
      if (!groupId) return ts.filter(t => t.id !== id);
      return ts.filter(t => !(t.repeatGroupId === groupId && t.date >= fromDate));
    });
    setSelectedTodo(prev => (prev?.id === id ? null : prev));
    if (!groupId) {
      deleteTodoRow(id).catch(notifyError("todo 삭제 실패"));
    } else {
      apiDeleteTodoRepeatGroup(groupId, fromDate).catch(notifyError("반복 할 일 삭제 실패"));
    }
  };
  const updateTodoTitle = (id: string, title: string) => {
    setTodos(ts => ts.map(t => t.id === id ? { ...t, title } : t));
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, title } : prev));
    updateTodo(id, { title }).catch(notifyError("todo 저장 실패"));
  };
  const updateTodoMemo = (id: string, memo: string) => {
    setTodos(ts => ts.map(t => t.id === id ? { ...t, memo } : t));
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, memo } : prev));
    updateTodo(id, { memo }).catch(notifyError("todo 메모 저장 실패"));
  };
  const updateTodoCategory = (id: string, category: string) => {
    setTodos(ts => ts.map(t => t.id === id ? { ...t, category } : t));
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, category } : prev));
    updateTodo(id, { category }).catch(notifyError("todo 카테고리 저장 실패"));
  };
  const updateTodoCountInCompletion = (id: string, countInCompletion: boolean) => {
    setTodos(ts => ts.map(t => t.id === id ? { ...t, countInCompletion } : t));
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, countInCompletion } : prev));
    updateTodo(id, { countInCompletion }).catch(notifyError("todo 달성률 설정 저장 실패"));
  };

  const refetchTodos = async () => {
    try { setTodos(await fetchTodos()); } catch (e) { notifyError("할 일 새로고침 실패")(e); }
  };

  // 반복 인스턴스 생성 — 블록과 동일한 날짜 생성기(generateRepeatDates)를 공유.
  // 멀티데이(endDate) todo 는 기간 길이를 유지한 채 각 인스턴스 날짜로 평행이동.
  const generateTodoRepeatInstances = (todo: Todo, repeat: BlockRepeat): Todo[] => {
    const groupId = todo.repeatGroupId || `trg-${todo.id}`;
    const spanDays = todo.endDate
      ? Math.round((parseLocalDate(todo.endDate).getTime() - parseLocalDate(todo.date).getTime()) / 86400000)
      : 0;
    return generateRepeatDates(todo.date, repeat).map(ds => {
      let end: string | null = null;
      if (spanDays > 0) {
        const d = parseLocalDate(ds);
        d.setDate(d.getDate() + spanDays);
        end = toDateStr(d);
      }
      return { ...todo, id: crypto.randomUUID(), date: ds, endDate: end, completed: false, repeatGroupId: groupId, repeat };
    });
  };

  // 할 일 반복 규칙 (재)적용 — setBlockRepeat 과 동일한 optimistic → DB reconcile 흐름.
  const setTodoRepeat = (id: string, repeat: BlockRepeat) => {
    const todo = todos.find(t => t.id === id);
    if (!todo) return;
    const groupId = `trg-${id}`;
    const updated = { ...todo, repeat, repeatGroupId: groupId };
    const instances = generateTodoRepeatInstances(updated, repeat);
    setTodos(ts => {
      const filtered = ts.filter(t => t.repeatGroupId !== groupId || t.id === id);
      return [...filtered.map(t => (t.id === id ? updated : t)), ...instances];
    });
    setSelectedTodo(prev => (prev && prev.id === id ? { ...prev, repeat, repeatGroupId: groupId } : prev));
    (async () => {
      try {
        await updateTodo(id, { repeat, repeatGroupId: groupId });
        // 규칙 재적용 시 이전 규칙의 인스턴스가 남으면 새/구가 섞이므로 원본만 남기고 정리 후 재삽입.
        await deleteTodoRepeatInstancesExceptOrigin(groupId, id);
        if (instances.length) await insertTodosBulk(instances);
        await refetchTodos();
      } catch (e) {
        notifyError("할 일 반복 저장 실패")(e);
        refetchTodos();
      }
    })();
  };

  // ── todo checklist ────────────────────────────────────────────────
  const addTodoChecklistItem = async (todoId: string, text: string, parentItemId?: string) => {
    try {
      const created = await createTodoChecklistItem(todoId, text, parentItemId);
      setTodoChecklistItems(is => [...is, created]);
    } catch (e) { notifyError("체크리스트 항목 추가 실패")(e); }
  };
  const toggleTodoChecklistItem = async (id: string, completed: boolean) => {
    setTodoChecklistItems(is => is.map(i => i.id === id ? { ...i, completed } : i));
    try { await toggleTodoChecklistItemRow(id, completed); }
    catch (e) { notifyError("체크리스트 저장 실패")(e); }
  };
  const deleteTodoChecklistItem = async (id: string) => {
    // FK ON DELETE CASCADE 로 DB 는 자동. 로컬은 하위 항목도 함께 정리.
    const snapshot = todoChecklistItems;
    const toRemove = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of snapshot) {
        if (it.parentItemId && toRemove.has(it.parentItemId) && !toRemove.has(it.id)) {
          toRemove.add(it.id); grew = true;
        }
      }
    }
    setTodoChecklistItems(is => is.filter(i => !toRemove.has(i.id)));
    try { await deleteTodoChecklistItemRow(id); }
    catch (e) { notifyError("체크리스트 삭제 실패")(e); }
  };

  // 드래그로 todo 를 다른 컬럼(날짜)/위치로 옮기거나, 다른 todo 위에 놓아 두 todo 순서를 교체.
  // 낙관적 업데이트 후 실패 시 롤백. sort_order 는 상대적 순서만 의미 있으므로 컬럼 내 재정렬 시
  // 컬럼 안 todo 들 전체에 0..n-1 을 다시 부여해 서로 겹치지 않게 정규화한다.
  const reorderTodos = (targetTodos: { id: string; date: string; sortOrder: number }[]) => {
    const map = new Map(targetTodos.map(t => [t.id, t]));
    const snapshot = todos;
    setTodos(ts => ts.map(t => {
      const upd = map.get(t.id);
      return upd ? { ...t, date: upd.date, sortOrder: upd.sortOrder } : t;
    }));
    bulkUpdateTodoOrder(targetTodos).catch(e => {
      setTodos(snapshot);
      notifyError("todo 순서 저장 실패")(e);
    });
  };

  // 지정 todo 를 새 날짜의 마지막에 붙임(단순 컬럼 이동).
  const moveTodoToDate = (id: string, newDate: string) => {
    const target = todos.find(t => t.id === id);
    if (!target) return;
    if (target.date === newDate) return;
    const destMax = Math.max(-1, ...todos.filter(t => t.date === newDate).map(t => t.sortOrder));
    reorderTodos([{ id, date: newDate, sortOrder: destMax + 1 }]);
  };

  // 두 todo 의 자리를 교체 — 같은 컬럼이면 sort_order 만, 다른 컬럼이면 date + sort_order 둘 다.
  const swapTodos = (aId: string, bId: string) => {
    const a = todos.find(t => t.id === aId);
    const b = todos.find(t => t.id === bId);
    if (!a || !b || a.id === b.id) return;
    reorderTodos([
      { id: a.id, date: b.date, sortOrder: b.sortOrder },
      { id: b.id, date: a.date, sortOrder: a.sortOrder },
    ]);
  };

  const todayBlocks = blocks.filter(b => b.date === TODAY_STR && !b.parentBlockId);
  const todayTodos = todos.filter(t => t.date === TODAY_STR || (t.endDate && TODAY_STR >= t.date && TODAY_STR <= t.endDate));
  // 달성률 — 시간 블록 + 할 일 중 countInCompletion 이 true 인 항목만 분모/분자에 포함.
  // 사용자가 "이 블록은 통계에서 빼고 싶다"고 표시한 항목은 계산 자체에서 제외.
  const completionBlocks = todayBlocks.filter(b => b.countInCompletion !== false);
  const completionTodos = todayTodos.filter(t => t.countInCompletion !== false);
  const completionTotal = completionBlocks.length + completionTodos.length;
  const completedCount = completionBlocks.filter(b => b.completed).length + completionTodos.filter(t => t.completed).length;
  const completionRate = completionTotal > 0 ? Math.round((completedCount / completionTotal) * 100) : 0;
  const totalPlanMin = todayBlocks.reduce((s, b) => s + durMin(b), 0);

  const navItems: { id: Section; label: string; Icon: React.FC<{ size: number }> }[] = [
    { id: "today", label: "오늘", Icon: Clock },
    { id: "calendar", label: "캘린더", Icon: Calendar },
    { id: "deadlines", label: "마감 작업", Icon: Target },
    { id: "grass", label: "활동 기록 & 통계", Icon: BarChart2 },
    { id: "memo", label: "메모", Icon: FileText },
    { id: "settings", label: "설정", Icon: Settings },
  ];

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground text-sm">
        불러오는 중...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm">
        <div className="text-center">
          <div className="text-destructive font-medium mb-1">데이터를 불러오지 못했습니다</div>
          <div className="text-muted-foreground text-xs">{loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">

      {/* ── Unified header: 앱 이름·날짜 + 타이머 + 달성률 + 창 컨트롤을 한 줄에 통합.
             decorations:false 상태에서 OS 크롬 대체 겸용 — 빈 영역 드래그로 창 이동,
             드래그 리전 위에서 더블클릭하면 최대화 토글(Windows 표준 동작). ── */}
      <header
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) return;
          const win = getCurrentWindow();
          win.isMaximized().then(m => (m ? win.unmaximize() : win.maximize())).catch(() => {});
        }}
        className="flex items-stretch h-14 border-b border-border bg-card flex-shrink-0"
      >
        {/* 좌우 flex-1로 균등 폭을 잡고 가운데 GlobalTimer는 별도 컨테이너에 두어야
             타이머가 창 정중앙에 온다. 예전엔 달성률 배지를 중앙 컨테이너 안에 함께 뒀는데
             그러면 두 개가 묶여서 중앙에 정렬돼 타이머가 왼쪽으로 밀려 보였음. */}

        {/* Left: 앱 아이덴티티 */}
        <div data-tauri-drag-region className="flex-1 flex items-center gap-3 pl-4 pr-3 min-w-0">
          <div data-tauri-drag-region className="flex items-center gap-2 pointer-events-none">
            <PlanoryMark size={16} />
            <span className="text-[13px] font-semibold tracking-tight text-foreground/85">Planory</span>
          </div>
        </div>

        {/* Center: 타이머만 배치 — 정중앙 유지 */}
        <div className="flex items-center flex-shrink-0">
          <GlobalTimer
            timerState={timerState}
            timerSec={timerSec}
            sessions={sessions}
            onStart={startSession}
            onManualStop={() => endSession("manual")}
            onReset={resetTodayTimer}
            pomodoroOn={pomodoroOn}
            pomPhase={pomPhase}
            pomPhaseRemainSec={Math.max(0, (pomPhase === "focus" ? pomWork : pomBreak) * 60 - pomPhaseSec)}
            floatWin={floatWin}
          />
        </div>

        {/* Right: 달성률 배지 + 창 컨트롤(min/max/close). Fitts's law상 창 컨트롤이 오른쪽
             모서리에 딱 붙어야 클릭이 편하므로 우측 컨테이너 자체엔 padding을 두지 않음. */}
        <div data-tauri-drag-region className="flex-1 flex items-stretch items-center justify-end min-w-0">
          <div data-tauri-drag-region className="flex items-center gap-2 px-3 pointer-events-none">
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg border border-border/80 bg-background/70 pointer-events-auto">
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">오늘 달성률</span>
              <span className="text-[11px] font-semibold tabular-nums text-foreground">{completionRate}%</span>
              <CircleProgress value={completionRate} size={16} strokeWidth={2.5} />
            </div>
          </div>
          <WindowControls />
        </div>
      </header>

      {/* ── Body (sidebar + main + panel) ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Sidebar */}
        <nav className="w-48 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col py-4">
          <div className="flex flex-col gap-0.5 px-2">
            {navItems.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all ${
                  section === id
                    ? "bg-primary text-primary-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-hidden flex min-w-0">
          {section === "today" && (
            <TodaySection
              // 오늘 달성률에 포함되지 않은(countInCompletion=false) 항목은 오늘 탭에서 아예 숨김.
              // 순수 참고용 계획(자유시간·이동 등)은 캘린더에서만 확인, 오늘 탭은 실제 트래킹만 노출.
              blocks={todayBlocks.filter(b => b.countInCompletion !== false)}
              deadlines={deadlines.filter(d => !d.completed)}
              todos={todos.filter(t =>
                (t.date === TODAY_STR || (t.endDate && TODAY_STR >= t.date && TODAY_STR <= t.endDate))
                && t.countInCompletion !== false
              )}
              templates={templates}
              todoChecklistItems={todoChecklistItems}
              completionRate={completionRate}
              onToggle={toggleBlock}
              onToggleDeadline={toggleDeadline}
              onToggleTodo={toggleTodo}
              onDeleteTodo={requestDeleteTodo}
              onAddTodo={addTodo}
              onReorderTodos={reorderTodos}
              onSwapTodo={swapTodos}
              onSelect={openBlockDetail}
              onSelectTodo={openTodoDetail}
              onSelectDeadline={openDeadlineDetail}
              onGoToCalendar={() => setSection("calendar")}
            />
          )}
          {section === "calendar" && (
            <CalendarSection
              blocks={blocks}
              deadlines={deadlines}
              templates={templates}
              todoChecklistItems={todoChecklistItems}
              calView={calView}
              setCalView={setCalView}
              templateOpen={templateOpen}
              setTemplateOpen={setTemplateOpen}
              onSelect={openBlockDetail}
              onSelectTodo={openTodoDetail}
              onSelectDeadline={openDeadlineDetail}
              onToggle={toggleBlock}
              onToggleDeadline={toggleDeadline}
              onAddBlock={addBlock}
              onUpdateBlock={updateBlock}
              onUpdateBlockLocal={updateBlockLocal}
              onDeleteBlock={requestDeleteBlock}
              onAddTemplate={addTemplate}
              onDeleteBlockTemplate={deleteTemplate}
              paletteColors={paletteColors}
              onAddPaletteColor={addPaletteColor}
              onRemovePaletteColor={removePaletteColor}
              blockClipboard={blockClipboard}
              setBlockClipboard={setBlockClipboard}
              onBulkMove={bulkMoveBlocks}
              onPasteBlocks={pasteBlocks}
              onBulkDelete={bulkDeleteBlocks}
              onBulkSetRepeat={bulkSetRepeatForBlocks}
              pushUndo={pushUndo}
              todos={todos}
              onAddTodo={addTodo}
              onDeleteTodo={requestDeleteTodo}
              onUpdateTodoTitle={updateTodoTitle}
              onMoveTodo={moveTodoToDate}
              onSwapTodo={swapTodos}
              onToggleTodo={toggleTodo}
              onUpdateTodoCategory={updateTodoCategory}
            />
          )}
          {section === "deadlines" && (
            <DeadlinesSection
              deadlines={deadlines} onToggle={toggleDeadline} onAddDeadline={addDeadline} onDelete={deleteDeadline}
              onUpdateDeadline={updateDeadline}
              paletteColors={paletteColors} onAddPaletteColor={addPaletteColor} onRemovePaletteColor={removePaletteColor}
            />
          )}
          {section === "grass" && (
            <GrassSection
              completionRate={completionRate}
              blocks={blocks.filter(b => !b.parentBlockId)}
              templates={templates}
              timerSec={timerSec}
              totalPlanMin={totalPlanMin}
              focusSecByDate={focusSecByDate}
            />
          )}
          {section === "memo" && (
            <MemoSection
              paletteColors={paletteColors}
              onAddPaletteColor={addPaletteColor}
              onRemovePaletteColor={removePaletteColor}
            />
          )}
          {section === "settings" && (
            <SettingsSection
              pomodoroOn={pomodoroOn} setPomodoroOn={setPomodoroOn}
              pomWork={pomWork} setPomWork={setPomWork}
              pomBreak={pomBreak} setPomBreak={setPomBreak}
              abandonOn={abandonOn} setAbandonOn={setAbandonOn}
              abandonMin={abandonMin} setAbandonMin={setAbandonMin}
              darkMode={darkMode} setDarkMode={setDarkMode}
              fontSize={fontSize} setFontSize={setFontSize}
            />
          )}
        </main>

        {/* Block detail side panel — todo 상세와 동일 레이아웃 (계획 시간만 블록 전용). */}
        {selectedBlock && (
          <BlockDetailPanel
            key={selectedBlock.id}
            block={selectedBlock}
            templates={templates}
            initialEditTitle={selectedBlock.id === justCreatedBlockId}
            paletteColors={paletteColors}
            onClose={() => setSelectedBlock(null)}
            onToggle={() => {
              toggleBlock(selectedBlock.id);
              setSelectedBlock({ ...selectedBlock, completed: !selectedBlock.completed });
            }}
            onDelete={() => requestDeleteBlock(selectedBlock.id)}
            onMemoSave={(memo) => {
              updateBlock(selectedBlock.id, { memo });
              setSelectedBlock({ ...selectedBlock, memo });
            }}
            onCategorySave={(category) => {
              updateBlock(selectedBlock.id, { category });
              setSelectedBlock({ ...selectedBlock, category });
            }}
            onCountInCompletionSave={(v) => {
              updateBlock(selectedBlock.id, { countInCompletion: v });
              setSelectedBlock({ ...selectedBlock, countInCompletion: v });
            }}
            onTitleSave={(title) => {
              updateBlock(selectedBlock.id, { title });
              setSelectedBlock({ ...selectedBlock, title });
              if (selectedBlock.id === justCreatedBlockId) {
                setJustCreatedBlockId(prev => (prev === selectedBlock.id ? null : prev));
              }
            }}
            onAddTemplate={addTemplate}
            onSetRepeat={(repeat) => {
              setBlockRepeat(selectedBlock.id, repeat);
              setSelectedBlock({ ...selectedBlock, repeat, repeatGroupId: `rg-${selectedBlock.id}` });
            }}
          />
        )}

        {/* 반복 블록 삭제 범위 확인 모달 — requestDeleteBlock 이 반복 그룹 소속을 감지했을 때만 뜸.
             '이 블록만' → 단건 삭제(반복 그룹은 유지) / '이후 전체' → 이 날짜부터 그룹 전체 삭제. */}
        {repeatDeletePrompt && (
          <RepeatDeleteModal
            title={repeatDeletePrompt.title}
            onClose={() => setRepeatDeletePrompt(null)}
            onDeleteOne={() => {
              const { id } = repeatDeletePrompt;
              setRepeatDeletePrompt(null);
              deleteBlock(id);
            }}
            onDeleteFollowing={() => {
              const { id, date } = repeatDeletePrompt;
              setRepeatDeletePrompt(null);
              deleteRepeatGroup(id, date);
            }}
          />
        )}

        {/* 반복 할 일 삭제 범위 확인 모달 — repeatDeletePrompt 의 todo 판. */}
        {todoRepeatDeletePrompt && (
          <RepeatDeleteModal
            title={todoRepeatDeletePrompt.title}
            noun="할 일"
            onClose={() => setTodoRepeatDeletePrompt(null)}
            onDeleteOne={() => {
              const { id } = todoRepeatDeletePrompt;
              setTodoRepeatDeletePrompt(null);
              deleteTodo(id);
            }}
            onDeleteFollowing={() => {
              const { id, date } = todoRepeatDeletePrompt;
              setTodoRepeatDeletePrompt(null);
              deleteTodoRepeatGroup(id, date);
            }}
          />
        )}

        {/* Deadline detail side panel — 시간 블록/할 일 상세와 같은 자리. 제목·마감일만 편집. */}
        {selectedDeadline && !selectedBlock && !selectedTodo && (
          <DeadlineDetailPanel
            key={selectedDeadline.id}
            deadline={selectedDeadline}
            onClose={() => setSelectedDeadline(null)}
            onToggle={() => {
              toggleDeadline(selectedDeadline.id);
              setSelectedDeadline({ ...selectedDeadline, completed: !selectedDeadline.completed });
            }}
            onDelete={() => {
              deleteDeadline(selectedDeadline.id);
              setSelectedDeadline(null);
            }}
            onTitleSave={(title) => {
              updateDeadline(selectedDeadline.id, { title });
              setSelectedDeadline({ ...selectedDeadline, title });
            }}
            onDueDateSave={(dueDate) => {
              updateDeadline(selectedDeadline.id, { dueDate });
              setSelectedDeadline({ ...selectedDeadline, dueDate });
            }}
          />
        )}

        {/* Todo detail side panel — 시간 블록의 상세 패널과 같은 자리에 뜨는 라이트 버전.
             선택된 todo 를 갱신하면 컴포넌트 내부 state 는 리마운트되어 새 값을 로드. */}
        {selectedTodo && !selectedBlock && (
          <TodoDetailPanel
            key={selectedTodo.id}
            todo={selectedTodo}
            templates={templates}
            initialEditTitle={selectedTodo.id === justCreatedTodoId}
            paletteColors={paletteColors}
            checklistItems={todoChecklistItems.filter(c => c.todoId === selectedTodo.id)}
            onClose={() => setSelectedTodo(null)}
            onToggle={() => toggleTodo(selectedTodo.id)}
            onDelete={() => requestDeleteTodo(selectedTodo.id)}
            onTitleSave={(title) => {
              updateTodoTitle(selectedTodo.id, title);
              if (selectedTodo.id === justCreatedTodoId) {
                setJustCreatedTodoId(prev => (prev === selectedTodo.id ? null : prev));
              }
            }}
            onMemoSave={(memo) => updateTodoMemo(selectedTodo.id, memo)}
            onCategorySave={(category) => updateTodoCategory(selectedTodo.id, category)}
            onCountInCompletionSave={(v) => updateTodoCountInCompletion(selectedTodo.id, v)}
            onAddTemplate={addTemplate}
            onSetRepeat={(repeat) => setTodoRepeat(selectedTodo.id, repeat)}
            onAddChecklistItem={(text, parentItemId) => addTodoChecklistItem(selectedTodo.id, text, parentItemId)}
            onToggleChecklistItem={(id, completed) => toggleTodoChecklistItem(id, completed)}
            onDeleteChecklistItem={(id) => deleteTodoChecklistItem(id)}
          />
        )}
      </div>
      <AppTooltipRoot />
      <Toaster position="bottom-right" duration={4000} />
    </div>
  );
}

// ── Window controls (Tauri decorations:false 상태에서 min/max/close 대체) ────
// 통합 헤더의 우측 끝에 붙어 창 오른쪽 모서리에 딱 닿음(Windows Fitts's law상 클릭 편의).
// 최대화 상태는 win.onResized로 감지해 아이콘을 restore-down으로 바꿈.
function WindowControls() {
  const [isMax, setIsMax] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMax).catch(() => {});
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    win.onResized(() => { win.isMaximized().then(setIsMax).catch(() => {}); })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const toggleMax = async () => {
    const win = getCurrentWindow();
    try {
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } catch (e) { console.error("최대화 토글 실패", e); }
  };

  const btnBase = "h-full w-11 flex items-center justify-center transition-colors text-muted-foreground";

  return (
    <div className="flex items-stretch h-full">
      <button
        onClick={() => getCurrentWindow().minimize().catch(e => console.error("최소화 실패", e))}
        className={`${btnBase} hover:bg-muted`}
        aria-label="최소화"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={toggleMax}
        className={`${btnBase} hover:bg-muted`}
        aria-label={isMax ? "이전 크기로" : "최대화"}
      >
        {isMax ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        onClick={() => getCurrentWindow().close().catch(e => console.error("닫기 실패", e))}
        className={`${btnBase} hover:bg-destructive hover:text-destructive-foreground`}
        aria-label="닫기"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Planory 브랜드 마크 ─────────────────────────────────────────────
// 3-pill 계단 = 오늘까지 쌓여 온 기록(plan+history). 좌상단 앱 아이덴티티와
// Tauri 패키지 아이콘(src-tauri/icons/planory-source.svg)의 축소판.
// 앱 아이콘 원본은 여백이 큰 512×512 타일이라 그대로 작게 그리면 알약이 너무 작게 보임.
// 헤더에선 타일 배경을 빼고 알약 3개 주변만 잘라낸 뷰박스로 그려서 텍스트 높이에 맞춰
// 시각적으로 균형 잡히게 함. size는 세로 높이 기준.
function PlanoryMark({ size = 20 }: { size?: number }) {
  const contentAspect = 272 / 114;
  return (
    <svg
      width={Math.round(size * contentAspect)}
      height={size}
      viewBox="120 195 272 114"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="128" y="283" width="200" height="22" rx="11" ry="11" fill="#384B60" />
      <rect x="156" y="245" width="200" height="22" rx="11" ry="11" fill="#5F8FBF" />
      <rect x="184" y="207" width="200" height="22" rx="11" ry="11" fill="#BEDAFA" />
    </svg>
  );
}

// ── Global Timer Widget ────────────────────────────────────────────
// 3-state: 실행중 / 자동 일시정지 / 수동 정지. "자동 일시정지"는 버튼으로 들어가는 상태가
// 아니라 창 포커스 변화로만 진입·해제됨(App의 onFocusChanged 로직 참고) — 그래서 여기엔
// "일시정지" 버튼이 없고 시작/정지만 있음.
function GlobalTimer({
  timerState, timerSec, sessions, onStart, onManualStop, onReset,
  pomodoroOn, pomPhase, pomPhaseRemainSec, floatWin,
}: {
  timerState: TimerState;
  timerSec: number;
  sessions: TimerSession[];
  onStart: () => void;
  onManualStop: () => void;
  onReset: () => void;
  pomodoroOn: boolean;
  pomPhase: "focus" | "break";
  pomPhaseRemainSec: number;
  floatWin: ReturnType<typeof useTimerWindow>;
}) {
  const isRunning = timerState === "running";
  const isAutoPaused = timerState === "auto-paused";
  const isStopped = timerState === "stopped";
  const isBreak = pomodoroOn && isRunning && pomPhase === "break";
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 px-4 py-1.5 rounded-xl border transition-all ${
          isBreak
            ? "bg-indigo-50 border-indigo-200"
            : isRunning
            ? "bg-sky-50 border-sky-200"
            : isAutoPaused
            ? "bg-amber-50 border-amber-200"
            : "bg-muted/40 border-border"
        }`}
      >
        {/* State indicator */}
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full flex-shrink-0 ${
              isBreak ? "bg-indigo-500 animate-pulse" :
              isRunning ? "bg-sky-500 animate-pulse" :
              isAutoPaused ? "bg-amber-400" :
              "bg-muted-foreground/40"
            }`}
          />
          <span
            className={`text-[11px] font-medium w-16 ${
              isBreak ? "text-indigo-700" :
              isRunning ? "text-sky-700" :
              isAutoPaused ? "text-amber-700" :
              "text-muted-foreground"
            }`}
          >
            {isBreak ? "휴식 중" : isRunning ? "집중 중" : isAutoPaused ? "자동 정지" : "정지됨"}
          </span>
        </div>

        {/* 뽀모도로 phase 남은 시간 — 활성일 때만 노출 */}
        {pomodoroOn && isRunning && (
          <span
            className={`text-[11px] tabular-nums font-medium ${isBreak ? "text-indigo-700" : "text-sky-700"}`}
            title={isBreak ? "휴식 남은 시간" : "집중 남은 시간"}
          >
            {fmtSec(pomPhaseRemainSec)}
          </span>
        )}

        {/* Timer display — click to see today's focus/rest session history */}
        <button
          onClick={() => setShowHistory(v => !v)}
          title="오늘의 집중 기록 보기"
          className={`text-xl font-medium tabular-nums w-20 text-center rounded-md hover:bg-black/5 transition-colors ${
            isRunning ? "text-sky-800" :
            isAutoPaused ? "text-amber-800" :
            "text-muted-foreground"
          }`}
                 >
          {fmtSec(timerSec)}
        </button>

        {/* Controls */}
        <div className="flex items-center gap-1">
          {isStopped && (
            <button
              onClick={onStart}
              title="타이머 시작"
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 transition-colors"
            >
              <Play size={11} fill="white" /> 시작
            </button>
          )}
          {isRunning && (
            <button
              onClick={onManualStop}
              title="정지"
              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
            >
              <Pause size={14} fill="currentColor" />
            </button>
          )}
          {isAutoPaused && (
            <>
              <button
                onClick={onStart}
                title="재시작"
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 transition-colors"
              >
                <Play size={11} fill="white" /> 재시작
              </button>
              <button
                onClick={onManualStop}
                title="정지"
                className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
              >
                <Pause size={14} fill="currentColor" />
              </button>
            </>
          )}

          {/* 다른 앱 위에서도 계속 뜨는 테두리 없는 타이머 창 */}
          <button
            onClick={() => (floatWin.isOpen ? floatWin.close() : floatWin.open())}
            title={floatWin.isOpen ? "뜬 타이머 닫기" : "다른 앱에서도 보이게 띄우기"}
            className={`p-1.5 rounded-lg transition-colors ${floatWin.isOpen ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
          >
            <PictureInPicture size={13} />
          </button>
        </div>
      </div>

      {showHistory && (
        <TimerHistoryPopover sessions={sessions} onClose={() => setShowHistory(false)} onReset={() => { onReset(); setShowHistory(false); }} />
      )}
    </div>
  );
}

// ── Timer session history popover ───────────────────────────────────
function TimerHistoryPopover({ sessions, onClose, onReset }: { sessions: TimerSession[]; onClose: () => void; onReset: () => void }) {
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const now = Date.now();
  const [confirmReset, setConfirmReset] = useState(false);

  type Segment = { type: "focus" | "rest"; startMs: number; endMs: number | null; endReason?: "manual" | "auto" | "ongoing" };
  const segments: Segment[] = [];
  sorted.forEach((s, i) => {
    const startMs = new Date(s.startedAt).getTime();
    const endMs = s.endedAt ? new Date(s.endedAt).getTime() : null;
    if (i > 0) {
      const prevEndedAt = sorted[i - 1].endedAt;
      if (prevEndedAt) {
        segments.push({ type: "rest", startMs: new Date(prevEndedAt).getTime(), endMs: startMs });
      }
    }
    segments.push({ type: "focus", startMs, endMs, endReason: s.endReason });
  });

  const fmtClock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const fmtDur = (ms: number) => {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  };

  const totalFocusMs = segments.filter(s => s.type === "focus").reduce((sum, s) => sum + ((s.endMs ?? now) - s.startMs), 0);
  const totalRestMs = segments.filter(s => s.type === "rest").reduce((sum, s) => sum + ((s.endMs ?? now) - s.startMs), 0);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-72 bg-card border border-border rounded-xl shadow-lg z-50 p-3">
        <div className="flex items-center justify-between gap-3 pb-2 mb-2 border-b border-border">
          <div>
            <div className="text-[10px] text-muted-foreground">오늘 총 집중</div>
            <div className="text-sm font-medium" >{fmtDur(totalFocusMs)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">오늘 총 휴식</div>
            <div className="text-sm font-medium" >{fmtDur(totalRestMs)}</div>
          </div>
        </div>
        {segments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-3">아직 오늘 기록이 없습니다</p>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {segments.slice().reverse().map((seg, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                {seg.type === "focus" ? (
                  <span className="size-1.5 rounded-full bg-sky-500 flex-shrink-0" />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                )}
                <span className="text-muted-foreground" >
                  {fmtClock(seg.startMs)}–{seg.endMs ? fmtClock(seg.endMs) : "진행중"}
                </span>
                <span className={seg.type === "focus" ? "font-medium" : "text-muted-foreground"}>
                  {seg.type === "focus" ? "집중" : "휴식"} {fmtDur((seg.endMs ?? now) - seg.startMs)}
                </span>
                {seg.type === "focus" && seg.endReason && seg.endReason !== "ongoing" && (
                  <span title={seg.endReason === "manual" ? "수동 정지" : "자동 정지(탭 이탈)"} className="ml-auto text-[9px] text-muted-foreground/70">
                    {seg.endReason === "manual" ? "■" : "↺"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 오늘 기록 초기화 — 실수 방지를 위해 두 단계 클릭(첫 클릭 → 확인 상태, 다시 클릭 → 실행) */}
        <div className="pt-2 mt-2 border-t border-border flex items-center justify-end gap-2">
          {confirmReset ? (
            <>
              <span className="text-[10px] text-muted-foreground">정말 초기화하시겠습니까?</span>
              <button onClick={() => setConfirmReset(false)} className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded">취소</button>
              <button onClick={onReset} className="text-[10px] text-destructive font-medium hover:bg-destructive/10 px-2 py-1 rounded">초기화</button>
            </>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded"
              title="오늘 타이머 기록 전부 삭제"
            >
              오늘 기록 초기화
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Circle Progress ────────────────────────────────────────────────
function CircleProgress({ value, size, strokeWidth = 5 }: { value: number; size: number; strokeWidth?: number }) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (value / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E4EEF7" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#5AA9E6" strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.4s ease" }}
      />
    </svg>
  );
}

// ── Today Section ──────────────────────────────────────────────────
function TodaySection({
  blocks, deadlines, todos, templates, todoChecklistItems, completionRate, onToggle, onToggleDeadline, onToggleTodo, onDeleteTodo, onAddTodo, onReorderTodos, onSwapTodo, onSelect, onSelectTodo, onSelectDeadline, onGoToCalendar,
}: {
  blocks: Block[];
  deadlines: Deadline[];
  todos: Todo[];
  templates: Template[];
  todoChecklistItems: TodoChecklistItemT[];
  completionRate: number;
  onToggle: (id: string) => void;
  onToggleDeadline: (id: string) => void;
  onToggleTodo: (id: string) => void;
  onDeleteTodo: (id: string) => void;
  onAddTodo: (t: { title: string; date: string; endDate?: string | null }) => void;
  onReorderTodos?: (targets: { id: string; date: string; sortOrder: number }[]) => void;
  onSwapTodo?: (aId: string, bId: string) => void;
  onSelect: (b: Block) => void;
  onSelectTodo?: (t: Todo) => void;
  onSelectDeadline?: (d: Deadline) => void;
  onGoToCalendar: () => void;
}) {
  const sorted = [...blocks].sort((a, b) => a.startH * 60 + a.startM - (b.startH * 60 + b.startM));
  const done = blocks.filter(b => b.completed).length;
  const overdueDeadlines = deadlines.filter(d => d.dueDate < TODAY_STR);
  // 오늘부터 7일 뒤(포함) 까지의 마감만 노출 — 달력 주(월~일) 가 아니라 슬라이딩 7일 창.
  // 화면에 매일 "일주일 내 임박한 마감" 만 유지돼 오늘 기준으로 급함을 판단하기 좋음.
  const oneWeekAheadStr = (() => {
    const d = new Date(TODAY_DATE);
    d.setDate(d.getDate() + 7);
    return toDateStr(d);
  })();
  const upcomingDeadlines = deadlines
    .filter(d => d.dueDate >= TODAY_STR && d.dueDate <= oneWeekAheadStr)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const [todoDraft, setTodoDraft] = useState("");
  const [dragTodoId, setDragTodoId] = useState<string | null>(null);
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  // sort_order 기준 정렬 — 시간표 뷰의 순서와 일관되게 유지. 같은 sort_order 는 created_at 순.
  const todoGroups = groupTodosByCategory(todos);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 pt-16 pb-8">
        {/* 오늘 달성률은 상단 헤더 타이머 옆 배지로 대체 — 여기선 별도 요약을 두지 않음.
             대신 이 페이지가 "오늘" 시점임을 상기시키는 작은 날짜 라벨만 얹음. */}
        <div className="text-[11px] text-muted-foreground mb-6">
          {`${TODAY_DATE.getFullYear()}년 ${TODAY_DATE.getMonth() + 1}월 ${TODAY_DATE.getDate()}일 ${DAYS_KO[TODAY_DATE.getDay()]}요일`}
        </div>

        {/* 지난 마감 — 이미 놓친 것. 배지는 항상 빨강 톤, 블록 색은 마감 커스텀 색이 있으면 그것을 우선. */}
        {overdueDeadlines.length > 0 && (
          <div className="mb-4">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">지난 마감</div>
            <div className="space-y-1.5">
              {overdueDeadlines.map(d => {
                const daysOver = Math.abs(daysBetween(parseLocalDate(d.dueDate), TODAY_DATE));
                const dayColor = deadlineToneHex(-daysOver);
                const blockColor = d.color || dayColor;
                return (
                  <div key={d.id}
                    onClick={() => onSelectDeadline?.(d)}
                    className={`group/dl flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${d.completed ? "bg-muted/40 border-transparent opacity-60 hover:border-transparent" : "hover:brightness-[0.97]"}`}
                    style={d.completed ? undefined : { backgroundColor: blockColor + "18", borderColor: blockColor + "55" }}
                    title="클릭: 상세 열기"
                  >
                    <button onClick={e => { e.stopPropagation(); onToggleDeadline(d.id); }} className="flex-shrink-0" title={d.completed ? "완료 해제" : "완료 처리"}>
                      {d.completed
                        ? <CheckCircle2 size={16} style={{ color: blockColor }} />
                        : <Circle size={16} style={{ color: blockColor, opacity: 0.85 }} />}
                    </button>
                    <span className="w-0.5 h-6 rounded-full flex-shrink-0" style={{ backgroundColor: blockColor }} />
                    <span className={`text-sm flex-1 min-w-0 truncate ${d.completed ? "line-through text-muted-foreground" : ""}`}>{d.title}</span>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                      style={{ backgroundColor: dayColor + "22", color: dayColor }}
                    >{daysOver}일 초과</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 일주일 내 마감 일정 — 오늘부터 +7일 이내(포함). 블록 색은 커스텀 우선, D-day 배지는 항상 D-day 톤으로
              초록→노랑→주황→빨강 규칙(>10 초록, 10 이하 노랑, 5 이하 주황, 3 이하 빨강)을 유지. */}
        {upcomingDeadlines.length > 0 && (
          <div className="mb-4">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">일주일 내 마감 일정</div>
            <div className="space-y-1.5">
              {upcomingDeadlines.map(d => {
                const daysLeft = daysBetween(parseLocalDate(d.dueDate), TODAY_DATE);
                const dayColor = deadlineToneHex(daysLeft);
                const blockColor = d.color || dayColor;
                return (
                  <div key={d.id}
                    onClick={() => onSelectDeadline?.(d)}
                    className={`group/dl flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${d.completed ? "bg-muted/40 border-transparent opacity-60 hover:border-transparent" : "hover:brightness-[0.97]"}`}
                    style={d.completed ? undefined : { backgroundColor: blockColor + "18", borderColor: blockColor + "55" }}
                    title="클릭: 상세 열기"
                  >
                    <button onClick={e => { e.stopPropagation(); onToggleDeadline(d.id); }} className="flex-shrink-0" title={d.completed ? "완료 해제" : "완료 처리"}>
                      {d.completed
                        ? <CheckCircle2 size={16} style={{ color: blockColor }} />
                        : <Circle size={16} style={{ color: blockColor, opacity: 0.85 }} />}
                    </button>
                    <span className="w-0.5 h-6 rounded-full flex-shrink-0" style={{ backgroundColor: blockColor }} />
                    <span className={`text-sm flex-1 min-w-0 truncate ${d.completed ? "line-through text-muted-foreground" : ""}`}>{d.title}</span>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                      style={{ backgroundColor: dayColor + "22", color: dayColor }}
                    >D-{daysLeft}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Todos — 마감과 시간 블록 사이. 시간표 블록과 동일한 스트라이프+체크박스 디자인.
              드래그로 서로 자리를 교체할 수 있고, 시간대는 지정하지 않음.
              카테고리별로 그룹을 나눠 헤더 + 그룹 하단에 구분선을 그림. */}
        <div className="mb-4">
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">오늘 일정</div>
          <div className="space-y-2">
            {todoGroups.map((group, gi) => (
              <div key={group.category || "__none__"} className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  <span>{group.category || "미분류"}</span>
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                {group.todos.map(t => {
                  const color = getCategoryColor(templates, t.category);
                  const clItems = todoChecklistItems.filter(c => c.todoId === t.id);
                  const clDone = clItems.filter(c => c.completed).length;
                  return (
                  <div key={t.id}
                    draggable={!!onSwapTodo}
                    onDragStart={e => {
                      if (!onSwapTodo) return;
                      e.dataTransfer.setData("todoId", t.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragTodoId(t.id);
                    }}
                    onDragEnd={() => { setDragTodoId(null); setSwapTargetId(null); }}
                    onDragOver={e => {
                      if (!onSwapTodo || !dragTodoId || dragTodoId === t.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setSwapTargetId(t.id);
                    }}
                    onDragLeave={() => { setSwapTargetId(prev => prev === t.id ? null : prev); }}
                    onDrop={e => {
                      if (!onSwapTodo) return;
                      const otherId = e.dataTransfer.getData("todoId");
                      if (!otherId || otherId === t.id) return;
                      e.preventDefault();
                      onSwapTodo(otherId, t.id);
                      setDragTodoId(null); setSwapTargetId(null);
                    }}
                    onClick={() => onSelectTodo?.(t)}
                    className={`group/todo flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      onSelectTodo ? "cursor-pointer" : onSwapTodo ? "cursor-grab active:cursor-grabbing" : ""
                    } ${
                      t.completed ? "bg-muted/40 border-transparent opacity-60"
                        : swapTargetId === t.id ? "bg-primary/10 border-primary ring-1 ring-primary/40"
                        : dragTodoId === t.id ? "bg-card border-primary/40 opacity-50"
                        : "bg-card border-border hover:border-primary/40"
                    }`}
                  >
                    <button onClick={e => { e.stopPropagation(); onToggleTodo(t.id); }} className="flex-shrink-0 mt-0.5">
                      {t.completed
                        ? <CheckCircle2 size={16} style={{ color }} />
                        : <Circle size={16} className="text-muted-foreground" />}
                    </button>
                    <span className="w-0.5 self-stretch rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      {/* 제목 옆에 카테고리(있으면) 를 인라인 뱃지로. 헤더가 있어도 시각적 강조를 위해 표시. */}
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className={`text-sm min-w-0 truncate ${t.completed ? "line-through text-muted-foreground" : ""}`}>{t.title}</span>
                        {t.category && (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
                            style={{ color, backgroundColor: color + "20" }}
                          >{t.category}</span>
                        )}
                      </div>
                      {t.memo && (
                        <span className="text-[11px] text-muted-foreground line-clamp-2 whitespace-pre-wrap break-words">{t.memo}</span>
                      )}
                      {/* 체크리스트 요약 — 있을 때만. done/total 카운트. */}
                      {clItems.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                          {clDone === clItems.length
                            ? <CheckCircle2 size={11} style={{ color }} />
                            : <Square size={11} className="text-muted-foreground" />}
                          <span>체크리스트 {clDone}/{clItems.length}</span>
                        </span>
                      )}
                    </div>
                    <button onClick={e => { e.stopPropagation(); onDeleteTodo(t.id); }}
                      className="opacity-0 group-hover/todo:opacity-100 text-muted-foreground hover:text-destructive transition-opacity mt-0.5"
                    ><X size={13} /></button>
                  </div>
                  );
                })}
                {gi < todoGroups.length - 1 && <div className="h-px bg-border/40" />}
              </div>
            ))}
            <input
              value={todoDraft}
              onChange={e => setTodoDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  const v = todoDraft.trim();
                  if (v) { onAddTodo({ title: v, date: TODAY_STR }); setTodoDraft(""); }
                }
              }}
              placeholder="+ 새 일정"
              className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border border-dashed border-border/60 hover:border-primary/40 focus:border-primary outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        {/* Block list — 시간 단위 블록 (todo 와 구분해서 아래에) */}
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">오늘 시간표</div>
        <div className="space-y-2">
          {sorted.map(block => {
            const color = getCategoryColor(templates, block.category);
            return (
            <div
              key={block.id}
              className={`group flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all cursor-pointer ${
                block.completed
                  ? "bg-muted/30 border-transparent opacity-60"
                  : "bg-card border-border hover:shadow-sm"
              }`}
              onClick={() => onSelect(block)}
            >
              <button
                className="flex-shrink-0"
                onClick={e => { e.stopPropagation(); onToggle(block.id); }}
              >
                {block.completed
                  ? <CheckCircle2 size={19} style={{ color }} />
                  : <Circle size={19} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                }
              </button>

              <div className="w-0.5 h-9 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />

              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium leading-snug ${block.completed ? "line-through text-muted-foreground" : ""}`}>
                  {block.title}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5" >
                  {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
                  <span className="ml-1.5 opacity-60">{durMin(block)}분</span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                {block.tags.map(tag => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{tag}</span>
                ))}
              </div>
            </div>
            );
          })}
        </div>

        {blocks.length === 0 && (
          <div className="mt-10 text-center py-8">
            <div className="text-sm font-medium text-muted-foreground">오늘 계획된 활동이 없습니다</div>
            <button
              onClick={onGoToCalendar}
              className="mt-3 text-xs px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              캘린더로 이동
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Calendar Section ───────────────────────────────────────────────
function CalendarSection({
  blocks, deadlines, templates, todoChecklistItems, calView, setCalView,
  templateOpen, setTemplateOpen, onSelect, onSelectTodo, onSelectDeadline, onToggle, onToggleDeadline, onAddBlock, onUpdateBlock, onUpdateBlockLocal, onDeleteBlock,
  onAddTemplate, onDeleteBlockTemplate,
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
  blockClipboard, setBlockClipboard, onBulkMove, onPasteBlocks, onBulkDelete, onBulkSetRepeat, pushUndo,
  todos, onAddTodo, onDeleteTodo, onUpdateTodoTitle, onMoveTodo, onSwapTodo, onToggleTodo, onUpdateTodoCategory,
}: {
  blocks: Block[];
  deadlines: Deadline[];
  templates: Template[];
  todoChecklistItems: TodoChecklistItemT[];
  calView: "day" | "week" | "month";
  setCalView: (v: "day" | "week" | "month") => void;
  templateOpen: boolean;
  setTemplateOpen: (v: boolean) => void;
  onSelect: (b: Block) => void;
  onSelectTodo?: (t: Todo) => void;
  onSelectDeadline?: (d: Deadline) => void;
  onToggle: (id: string) => void;
  onToggleDeadline: (id: string) => void;
  onAddBlock: (block: Block, options?: { select?: boolean; openInline?: boolean }) => void;
  onUpdateBlock: (id: string, changes: Partial<Block>) => void;
  onUpdateBlockLocal: (id: string, changes: Partial<Block>) => void;
  onDeleteBlock: (id: string) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[]; kind?: "time" | "todo" }) => void;
  onDeleteBlockTemplate: (id: string) => void;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
  blockClipboard: Block[];
  setBlockClipboard: (bs: Block[]) => void;
  onBulkMove: (moves: Array<{ id: string; newDate: string; newStartMin: number }>) => Promise<void>;
  onPasteBlocks: (source: Block[], targetDate: string) => Promise<void>;
  onBulkDelete: (ids: string[]) => Promise<void>;
  onBulkSetRepeat: (ids: string[], repeat: BlockRepeat) => void;
  pushUndo: (fn: () => Promise<void> | void) => void;
  todos: Todo[];
  onAddTodo: (t: { title: string; date: string; endDate?: string | null; color?: string }, options?: { openInline?: boolean }) => void;
  onDeleteTodo: (id: string) => void;
  onUpdateTodoTitle: (id: string, title: string) => void;
  onMoveTodo: (id: string, newDate: string) => void;
  onSwapTodo: (aId: string, bId: string) => void;
  onToggleTodo: (id: string) => void;
  onUpdateTodoCategory: (id: string, category: string) => void;
}) {
  const HOUR_H = 64;
  const TOTAL_H = 24;
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // 글씨 크기 설정이 html에 CSS zoom을 걸어 앱 전체를 스케일하는데,
  // 마우스 이벤트 좌표와 getBoundingClientRect는 시각적 viewport px로 반환되는 반면
  // HOUR_H 같은 레이아웃 상수는 zoom이 안 걸린 CSS px 이라, delta를 zoom으로 나눠줘야
  // hover ghost 위치가 실제 마우스 위치와 일치함.
  const getRootZoom = () => parseFloat(document.getElementById("root")?.style.zoom ?? "") || 1;

  // 자식 블록(독립 타임블록형)은 부모의 상세 패널 안에서만 다뤄지고, 캘린더 그리드에는
  // 최상위 블록만 표시됨 — 안 그러면 부모 시간대 안에 자식이 겹쳐 보이거나 통계가 중복 집계됨.
  const topLevelBlocks = blocks.filter(b => !b.parentBlockId);

  const [viewDate, setViewDate] = useState(TODAY_DATE);
  // 어느 종류의 템플릿을 새로 만드는지 — null 이면 폼 닫힘, "time"/"todo" 면 해당 종류로 열림.
  const [showNewTpl, setShowNewTpl] = useState<null | "time" | "todo">(null);
  const [showTplCustomColor, setShowTplCustomColor] = useState(false);
  const [newTplTitle, setNewTplTitle] = useState("");
  const [newTplColor, setNewTplColor] = useState("#5AA9E6");
  const [dragTplId, setDragTplId] = useState<string | null>(null);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragBlockOffsetMin, setDragBlockOffsetMin] = useState(0); // minutes from block top to mouse
  const [dropTarget, setDropTarget] = useState<{ dayIdx: number; startH: number; startM: number } | null>(null);
  // 마우스를 그리드에 올렸을 때 클릭하면 새 블록이 놓일 위치를 미리 보여주는 hover ghost.
  // 15분 스냅으로 startMin(분 단위)을 저장 — 정시 스냅은 UX 요청으로 해제됨.
  const [hoverSlot, setHoverSlot] = useState<{ dayIdx: number; startMin: number } | null>(null);
  const [resizing, setResizing] = useState<{
    blockId: string; edge: "top" | "bottom";
    startY: number; origStartMin: number; origEndMin: number; blockDate: string;
  } | null>(null);

  // ── 다중 선택 상태 ────────────────────────────────────────────────
  // Windows 파일탐색기처럼 여러 블록을 한꺼번에 다루기 위한 선택 세트.
  // - Ctrl/⌘+클릭: 토글
  // - 빈 영역 mousedown → 드래그: 마퀴 사각형 (교차하는 블록 모두 선택)
  // - Esc: 해제
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 진행 중인 마퀴 — 좌표는 timeGridRef 콘텐츠 상대 좌표계에 저장.
  // 컨테이너 스크롤이 발생해도 콘텐츠 좌표는 안정적이라 마퀴 앵커가 튀지 않고,
  // 그리드 전체(여러 요일 컬럼 + 24시간 세로 축) 어느 지점이든 자유롭게 드래그 가능.
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const timeGridRef = useRef<HTMLDivElement>(null);
  // 일/주 뷰 콘텐츠 모드 — grid(시간표만) / todos(일정만) / both(위 시간표 + 아래 일정 리스트).
  // 사용자가 마지막으로 켜둔 시간표/할 일 상태를 세션 간에 유지. useState 로 두면
  // CalendarSection 이 다른 탭 이동 시 언마운트돼 값이 "both" 로 리셋되던 문제.
  const [contentView, setContentView] = usePersistedState<"grid" | "todos" | "both">("cal_content_view", "both");
  // 할 일 리스트 그룹 기준 — date(날짜별, 기본) / category(카테고리별). 세션 간 유지.
  const [todoGroupMode, setTodoGroupMode] = usePersistedState<"date" | "category">("cal_todo_group_mode", "date");
  // both 뷰에서 상단(시간표) 비율 — 하단(일정) 은 1 - splitRatio. 사용자가 경계선을 드래그해서 조정.
  const [splitRatio, setSplitRatio] = useState(0.6);
  const bothContainerRef = useRef<HTMLDivElement>(null);
  const startSplitterDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = bothContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (mv: MouseEvent) => {
      const ratio = Math.max(0.15, Math.min(0.85, (mv.clientY - rect.top) / rect.height));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  // 월 뷰 셀 클릭으로 새 todo 인라인 입력 중인 날짜 & 각 셀 별 draft 입력값.
  const [monthEditing, setMonthEditing] = useState<string | null>(null);
  const [monthDrafts, setMonthDrafts] = useState<Record<string, string>>({});
  // 월 뷰 셀 hover — 마우스 올리면 "새 일정" 프리뷰 그림자를 띄우기 위한 상태.
  const [monthHoverDate, setMonthHoverDate] = useState<string | null>(null);
  // 우클릭 컨텍스트 메뉴 — 화면 절대 좌표.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 다중 반복 설정 모달 열림 여부.
  const [showMultiRepeat, setShowMultiRepeat] = useState(false);
  // 헤더 "YYYY년 M월" 라벨을 눌렀을 때 뜨는 연/월(/일) 점프 팝오버 상태.
  // 월 뷰: 연 + 12개월 그리드 → 클릭 즉시 이동.
  // 일/주 뷰: 연 + 월 그리드로 표시할 달을 선택 → 그 아래 일 그리드에서 원하는 날짜 클릭.
  // 하나씩 화살표로 옮기지 않고 원하는 시점으로 바로 이동하기 위한 UI.
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [monthPickerYear, setMonthPickerYear] = useState(TODAY_DATE.getFullYear());
  const [monthPickerMonth, setMonthPickerMonth] = useState(TODAY_DATE.getMonth());
  const monthPickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!monthPickerOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (monthPickerRef.current && !monthPickerRef.current.contains(e.target as Node)) setMonthPickerOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setMonthPickerOpen(false); };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [monthPickerOpen]);

  const blocksRef = useRef(topLevelBlocks);
  useEffect(() => { blocksRef.current = topLevelBlocks; }, [topLevelBlocks]);
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const viewDateRef = useRef<Date>(TODAY_DATE);

  // 사용자 편의: 선택된 블록의 정보 (드래그 앵커 판정, 컨텍스트 메뉴 표시 등)
  const selectedBlocks = topLevelBlocks.filter(b => selectedIds.has(b.id));

  // 마우스 이동에 따라 마퀴가 확장되도록 document 레벨 리스너 부착.
  // 좌표는 timeGridRef 콘텐츠 좌표계로 변환해서 저장 — 스크롤이 발생해도 rect.top 이 변하며
  // 그 변화가 clientY 변환에 자동 반영되므로 앵커/추적 모두 안정적.
  // 컨테이너 스크롤 이벤트도 동시에 리스닝해서, 마우스는 가만히 있고 스크롤만 발생해도 마퀴 크기가
  // 자연스럽게 갱신되도록(마우스가 지나가는 지점의 콘텐츠 y 가 스크롤에 따라 변하는 걸 반영).
  useEffect(() => {
    if (!marquee) return;
    let lastClientX = 0, lastClientY = 0;
    const toContent = (cx: number, cy: number) => {
      if (!timeGridRef.current) return { x: cx, y: cy };
      const r = timeGridRef.current.getBoundingClientRect();
      // 시각 px → 콘텐츠(레이아웃) px 변환 — CSS zoom(글씨 크기) 보정.
      const z = getRootZoom();
      return { x: (cx - r.left) / z, y: (cy - r.top) / z };
    };
    const onMove = (e: MouseEvent) => {
      lastClientX = e.clientX; lastClientY = e.clientY;
      const p = toContent(e.clientX, e.clientY);
      setMarquee(m => m ? { ...m, curX: p.x, curY: p.y } : m);
    };
    const onScroll = () => {
      if (lastClientX === 0 && lastClientY === 0) return;
      const p = toContent(lastClientX, lastClientY);
      setMarquee(m => m ? { ...m, curX: p.x, curY: p.y } : m);
    };
    const onUp = (e: MouseEvent) => {
      // 마퀴 종료 시 그리드 콘텐츠 좌표계의 사각형을 산출한 뒤, 화면에 보이는 모든 요일 컬럼을
      // 순회하며 각 컬럼의 콘텐츠 x-범위와 교차 여부를 판정. 교차하는 컬럼에 속한 블록 중
      // y-범위가 마퀴와 겹치는 것을 선택. 이렇게 하면 여러 요일에 걸친 드래그가 자연스럽게 동작.
      const end = toContent(e.clientX, e.clientY);
      const mX0 = Math.min(marquee.startX, end.x);
      const mX1 = Math.max(marquee.startX, end.x);
      const mY0 = Math.min(marquee.startY, end.y);
      const mY1 = Math.max(marquee.startY, end.y);
      const grid = timeGridRef.current;
      if (grid) {
        const gridRect = grid.getBoundingClientRect();
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        const hits = new Set<string>();
        if (additive) selectedIdsRef.current.forEach(id => hits.add(id));
        const zoom = getRootZoom();
        const cols = grid.querySelectorAll<HTMLElement>("[data-marquee-column]");
        cols.forEach(col => {
          const cRect = col.getBoundingClientRect();
          const cX0 = (cRect.left - gridRect.left) / zoom;
          const cX1 = (cRect.right - gridRect.left) / zoom;
          if (mX1 <= cX0 || mX0 >= cX1) return;
          const dateStr = col.dataset.date;
          if (!dateStr) return;
          for (const b of blocksRef.current) {
            if (b.date !== dateStr) continue;
            const bTop = (b.startH * 60 + b.startM) / 60 * HOUR_H;
            const bBot = (b.endH * 60 + b.endM) / 60 * HOUR_H;
            if (mY0 < bBot && mY1 > bTop) hits.add(b.id);
          }
        });
        setSelectedIds(hits);
      }
      setMarquee(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    const scrollEl = gridScrollRef.current;
    scrollEl?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scrollEl?.removeEventListener("scroll", onScroll);
    };
  }, [marquee]);

  // Esc — 선택 해제 + 컨텍스트 메뉴 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedIds(new Set());
        setCtxMenu(null);
        setShowMultiRepeat(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 마우스 마지막 위치 — Ctrl+V 시 커서가 놓인 요일 컬럼을 붙여넣기 대상으로 쓰기 위해 추적.
  // useState 는 매 mousemove 마다 리렌더 폭탄이라 안 되고, ref 로만 축적.
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => { lastMouseRef.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  // Ctrl+C / Ctrl+V — 캘린더 뷰가 활성일 때만 유효. 입력 필드에서 타이핑 중이면 브라우저 기본
  // 복사/붙여넣기를 방해하지 않도록 스킵.
  useEffect(() => {
    const isInInput = () => {
      const t = document.activeElement as HTMLElement | null;
      const tag = t?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (t as any)?.isContentEditable;
    };
    // 현재 마우스가 놓인 요일 컬럼의 date 를 반환. 데이 그리드/할 일 컬럼 모두 [data-date]
    // 를 붙여두었으므로 closest 로 찾음. 컬럼 밖이면 null.
    const dateUnderCursor = (): string | null => {
      const m = lastMouseRef.current;
      if (!m) return null;
      const el = document.elementFromPoint(m.x, m.y) as HTMLElement | null;
      const col = el?.closest?.("[data-date]") as HTMLElement | null;
      return col?.dataset.date ?? null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isInInput()) return;
      const key = e.key.toLowerCase();
      if (key === "c" && !e.shiftKey) {
        const picked = topLevelBlocks.filter(b => selectedIdsRef.current.has(b.id));
        if (picked.length === 0) return;
        e.preventDefault();
        setBlockClipboard(picked);
      } else if (key === "v" && !e.shiftKey) {
        if (blockClipboard.length === 0) return;
        e.preventDefault();
        // 마우스가 올라가 있는 요일 컬럼이 있으면 그 날짜로. 없으면 viewDate 로 폴백
        // (일 뷰의 그 날짜, 주 뷰의 그 주 시작일).
        const targetDate = dateUnderCursor() ?? toDateStr(viewDateRef.current);
        onPasteBlocks(blockClipboard, targetDate);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [topLevelBlocks, blockClipboard, setBlockClipboard, onPasteBlocks]);

  // 컨텍스트 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [ctxMenu]);

  // viewDate 를 ref 로 미러링 — 키보드 붙여넣기 핸들러가 stale closure로 어제 뷰에 붙이지 않게.
  useEffect(() => { viewDateRef.current = viewDate; }, [viewDate]);

  // The browser fires a synthetic "click" right after mouseup even when that mouseup ends a
  // resize drag (mousedown started on the resize handle, a child of the block). React's state
  // update from setResizing(null) isn't guaranteed to have committed before that click event
  // reaches the block's onClick, so checking `resizing` there is a race. A ref is synchronous
  // and immune to that timing, so use it to suppress the click for one tick after a resize ends.
  const justResizedRef = useRef(false);

  // 시간 그리드 세로 스크롤 위치를 localStorage 로 보존 — 다른 섹션 갔다가 돌아와도
  // 같은 시간대가 보이도록. 저장된 값이 없으면 기본 7시로 스크롤 (첫 진입 UX 유지).
  // ⚠ 스크롤 위치는 값이 바뀌어도 리렌더가 필요 없으므로 usePersistedState 대신
  //   ref + 이벤트 리스너로 처리해 프레임당 setState 폭주를 피함.
  useEffect(() => {
    if (calView === "month") return;
    const el = gridScrollRef.current;
    if (!el) return;
    const KEY = "cal_grid_scroll_top";
    // 복원 — 저장된 값이 있으면 그 위치로, 없으면 7시 기본.
    let restored = 7 * HOUR_H;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) restored = n;
      }
    } catch {}
    el.scrollTop = restored;
    // 스크롤 저장 — rAF 로 프레임당 1회로 스로틀.
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { localStorage.setItem(KEY, String(el.scrollTop)); } catch {}
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [calView]);

  // Resize mouse tracking — uses the local-only updater for live visual feedback on every
  // mousemove (hitting the DB that often would be wasteful); the final value is persisted
  // once on mouseup.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      // clientY 는 CSS zoom(글씨 크기)이 반영된 시각 px — HOUR_H(레이아웃 px)와 맞추려면 zoom 으로 나눔.
      const deltaMin = Math.round(((e.clientY - resizing.startY) / getRootZoom() / HOUR_H) * 60 / 15) * 15;
      const peers = blocksRef.current.filter(b => b.id !== resizing.blockId && b.date === resizing.blockDate);
      const clash = (sMin: number, eMin: number) =>
        peers.some(b => sMin < b.endH * 60 + b.endM && eMin > b.startH * 60 + b.startM);
      if (resizing.edge === "bottom") {
        const newEnd = Math.max(resizing.origStartMin + 15, Math.min(TOTAL_H * 60, resizing.origEndMin + deltaMin));
        if (!clash(resizing.origStartMin, newEnd))
          onUpdateBlockLocal(resizing.blockId, { endH: Math.floor(newEnd / 60), endM: newEnd % 60 });
      } else {
        const newStart = Math.min(resizing.origEndMin - 15, Math.max(0, resizing.origStartMin + deltaMin));
        if (!clash(newStart, resizing.origEndMin))
          onUpdateBlockLocal(resizing.blockId, { startH: Math.floor(newStart / 60), startM: newStart % 60 });
      }
    };
    const onUp = () => {
      const final = blocksRef.current.find(b => b.id === resizing.blockId);
      if (final) onUpdateBlock(final.id, { startH: final.startH, startM: final.startM, endH: final.endH, endM: final.endM });
      setResizing(null);
      justResizedRef.current = true;
      setTimeout(() => { justResizedRef.current = false; }, 0);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizing, onUpdateBlock, onUpdateBlockLocal]);

  // Navigation helpers
  const goPrev = () => {
    const d = new Date(viewDate);
    if (calView === "day") d.setDate(d.getDate() - 1);
    else if (calView === "week") d.setDate(d.getDate() - 7);
    else d.setMonth(d.getMonth() - 1);
    setViewDate(d);
  };
  const goNext = () => {
    const d = new Date(viewDate);
    if (calView === "day") d.setDate(d.getDate() + 1);
    else if (calView === "week") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    setViewDate(d);
  };

  const getWeekDays = (date: Date) => {
    const dow = date.getDay();
    const sun = new Date(date);
    sun.setDate(date.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(sun); d.setDate(sun.getDate() + i); return d; });
  };

  const viewDays = calView === "day" ? [viewDate] : getWeekDays(viewDate);

  // 상세 날짜/요일은 아래 요일 헤더가 보여주므로 상단 라벨은 연/월만 표시.
  const headerLabel = (() => {
    if (calView === "week") {
      const s = viewDays[0], e = viewDays[6];
      if (s.getMonth() !== e.getMonth()) {
        return s.getFullYear() === e.getFullYear()
          ? `${s.getFullYear()}년 ${s.getMonth()+1}월 – ${e.getMonth()+1}월`
          : `${s.getFullYear()}년 ${s.getMonth()+1}월 – ${e.getFullYear()}년 ${e.getMonth()+1}월`;
      }
      return `${s.getFullYear()}년 ${s.getMonth()+1}월`;
    }
    return `${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월`;
  })();

  const hasOverlapForDate = (dateStr: string, startMin: number, endMin: number, excludeId?: string) =>
    topLevelBlocks.filter(b => b.date === dateStr && b.id !== excludeId)
      .some(b => startMin < b.endH * 60 + b.endM && endMin > b.startH * 60 + b.startM);

  const dragTemplate = dragTplId ? templates.find(t => t.id === dragTplId) ?? null : null;
  const dragBlock = dragBlockId ? topLevelBlocks.find(b => b.id === dragBlockId) ?? null : null;

  // ── Shared time-grid renderer (day + week) ──────────────────────
  const renderTimeGrid = (days: Date[]) => (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Day headers — 좌측 게이지 자리(w-12) 안에 이전 화살표, 우측 끝에 겹쳐 다음 화살표.
           우측은 absolute 로 얹어 아래 시간 그리드 컬럼 폭과 어긋나지 않게 함.
           scrollbar-gutter: stable + overflow-hidden 조합으로 아래 스크롤 영역이 차지하는
           스크롤바 폭만큼 우측 여백을 항상 예약해 컬럼 세로선이 정확히 정렬되도록. */}
      <div className="relative flex border-b border-border flex-shrink-0 bg-card items-stretch overflow-hidden [scrollbar-gutter:stable]">
        <button
          onClick={goPrev}
          className="w-12 flex-shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          title="이전"
        ><ChevronLeft size={16} /></button>
        {days.map((day, i) => {
          const ds = toDateStr(day);
          const isToday = ds === TODAY_STR;
          const dow = day.getDay();
          const holiday = getHoliday(ds);
          return (
            <div
              key={i}
              className="flex-1 text-center py-2 min-w-0 cursor-pointer hover:bg-muted/40 transition-colors rounded-lg"
              onClick={() => { setViewDate(day); setCalView("day"); }}
              title={holiday ? `${holiday} — 이 날짜 일 캘린더로 이동` : "이 날짜 일 캘린더로 이동"}
            >
              <div className={`text-[10px] ${holiday || (days.length > 1 && dow === 0) ? "text-red-400" : days.length > 1 && dow === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                {DAYS_KO[dow]}
              </div>
              <div className={`inline-flex items-center justify-center w-7 h-7 mt-0.5 rounded-full text-xs font-medium ${isToday ? "bg-primary text-primary-foreground" : holiday ? "text-red-400" : "text-foreground"}`}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
        <button
          onClick={goNext}
          className="absolute right-0 top-0 bottom-0 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors rounded-l"
          title="다음"
        ><ChevronRight size={16} /></button>
      </div>

      {/* 고정 마감 행 — 요일/날짜 헤더 바로 밑. 아래 시간 그리드가 스크롤돼도 이 행은 상단에 남는다.
           각 요일 컬럼별로 그 날짜의 마감을 남은 일수 톤으로 나열하고 D-day 배지를 붙임.
           scrollbar-gutter:stable 로 아래 스크롤 영역과 컬럼 폭을 맞춤. */}
      <div className="relative flex border-b border-border flex-shrink-0 bg-card items-stretch overflow-hidden [scrollbar-gutter:stable]">
        <div className="w-12 flex-shrink-0 flex items-start justify-end pt-1 pr-2 text-[9px] text-muted-foreground select-none">마감</div>
        {days.map((day, i) => {
          const ds = toDateStr(day);
          const cellDeadlines = deadlines.filter(d => d.dueDate === ds);
          return (
            <div key={i} className="flex-1 min-w-0 border-l border-border/40 px-1 py-1 space-y-0.5">
              {cellDeadlines.map(d => {
                const daysLeft = daysBetween(parseLocalDate(d.dueDate), TODAY_DATE);
                // 블록 색은 마감 커스텀 색이 있으면 그것을, 없으면 D-day 톤을 사용.
                // D-day 배지는 항상 D-day 톤을 그대로 사용해 "얼마나 남았는지" 를 색으로도 즉시 표시.
                const dayColor = deadlineToneHex(daysLeft);
                const blockColor = d.color || dayColor;
                return (
                  <div
                    key={d.id}
                    onClick={() => onSelectDeadline?.(d)}
                    className={`rounded overflow-hidden text-[10px] cursor-pointer transition-all flex items-center gap-1 pr-1 ${d.completed ? "opacity-60" : "hover:brightness-95"}`}
                    style={{ backgroundColor: blockColor + "28", borderLeft: `3px solid ${blockColor}` }}
                    title="클릭: 상세 열기"
                  >
                    <span
                      className={`truncate font-medium leading-tight px-1 py-0.5 flex-1 min-w-0 ${d.completed ? "line-through" : ""}`}
                      style={{ color: blockColor }}
                    >{d.title}</span>
                    <span className="text-[9px] font-semibold leading-none flex-shrink-0" style={{ color: dayColor }}>
                      {formatDDay(daysLeft)}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Scrollable grid — 위쪽 고정 마감 행(요일/날짜 헤더 바로 아래)과 아래 시간 그리드 사이.
           scrollbar-gutter: stable 로 스크롤 유무와 상관없이 스크롤바 폭을 예약해 위/아래 영역과 컬럼을 정렬. */}
      <div ref={gridScrollRef} className="flex-1 overflow-auto [scrollbar-gutter:stable]">
        <div ref={timeGridRef} className="flex relative" style={{ height: TOTAL_H * HOUR_H }}>
          {/* 마퀴 오버레이 — 그리드 전체 좌표계에서 렌더되어 여러 요일 컬럼을 가로지를 수 있고,
               세로로도 24시간 그리드 어디에서든 클립 없이 이어짐. z-40 로 스틱키 헤더 위에 뜸. */}
          {marquee && (
            <div
              className="absolute border-2 border-primary/60 bg-primary/10 pointer-events-none z-40"
              style={{
                left: Math.min(marquee.startX, marquee.curX),
                top: Math.min(marquee.startY, marquee.curY),
                width: Math.abs(marquee.curX - marquee.startX),
                height: Math.abs(marquee.curY - marquee.startY),
              }}
            />
          )}
          {/* Hour labels — h=0 라벨은 top clamp로 잘리지 않게 */}
          <div className="w-12 flex-shrink-0 relative select-none">
            {Array.from({ length: TOTAL_H }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted-foreground"
                style={{ top: h === 0 ? 2 : h * HOUR_H - 7 }}>
                {fmt2(h)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, di) => {
            const dateStr = toDateStr(day);
            const isToday = dateStr === TODAY_STR;
            const dayBlocks = topLevelBlocks.filter(b => b.date === dateStr);
            const isDropTarget = dropTarget?.dayIdx === di;
            const ghostStartMin = isDropTarget && dropTarget ? dropTarget.startH * 60 + dropTarget.startM : null;
            const ghostEndMin = ghostStartMin !== null ? Math.min(TOTAL_H * 60, ghostStartMin + 60) : null;
            const isGhostOverlap = ghostStartMin !== null && ghostEndMin !== null
              ? hasOverlapForDate(dateStr, ghostStartMin, ghostEndMin) : false;

            return (
              <div
                key={di}
                data-marquee-column={di}
                data-date={dateStr}
                className={`flex-1 relative border-l border-border min-w-0 ${isToday ? "bg-sky-50/10" : ""}`}
                style={{ height: TOTAL_H * HOUR_H }}
                // 빈 영역 mousedown = "새 블록 만들지 아니면 마퀴 드래그로 다중 선택할지" 결정.
                // mousemove로 4px 이상 이동하면 마퀴로 승격되고, 그 사이 setMarquee 가 진행 상태를 채움.
                // 그대로 mouseup 하면 새 블록 생성(기존 클릭 동작 유지). marquee 종료 시엔 새 블록을
                // 만들지 않도록 mouseup 핸들러 안에서 marquee 여부를 확인.
                // 마퀴 좌표는 timeGridRef 콘텐츠 좌표계 — 스크롤/열간 자유 이동에 견고.
                onMouseDown={e => {
                  if (e.button !== 0) return; // 좌클릭만
                  if (resizing || dragBlockId || dragTplId) return;
                  // 블록·리사이즈 핸들 등 자식 위에서 눌린 mousedown 은 여기까지 버블링해서
                  // 마퀴로 승격돼 버림 — 그러면 사용자가 블록을 잡고 드래그하는 사이 마퀴 상태가
                  // 함께 켜졌다가 HTML5 dragend 로 mouseup 이 억제되면서 마퀴가 꺼지지 않고
                  // 남아, 이후 mousedown+이동이 곧바로 "또 하나의 마퀴" 로 잡히는 유령 상태가 됨.
                  // e.target 이 컬럼 배경 그 자체일 때만 진행.
                  if (e.target !== e.currentTarget) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const startAbsX = e.clientX;
                  const startAbsY = e.clientY;
                  const startClickTs = Date.now();
                  let becameMarquee = false;
                  const onMove = (mv: MouseEvent) => {
                    if (Math.abs(mv.clientY - startAbsY) > 4 || Math.abs(mv.clientX - startAbsX) > 4) {
                      becameMarquee = true;
                      const grid = timeGridRef.current;
                      if (grid) {
                        const gRect = grid.getBoundingClientRect();
                        // 시각 px → 콘텐츠 px — CSS zoom(글씨 크기) 보정.
                        const z = getRootZoom();
                        setMarquee({
                          startX: (startAbsX - gRect.left) / z,
                          startY: (startAbsY - gRect.top) / z,
                          curX: (mv.clientX - gRect.left) / z,
                          curY: (mv.clientY - gRect.top) / z,
                        });
                      }
                      document.removeEventListener("mousemove", onMove);
                    }
                  };
                  const onUp = (up: MouseEvent) => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    if (becameMarquee) return; // 마퀴가 시작됐다면 marquee useEffect 가 mouseup 을 처리
                    // 짧게 눌렀다 뗀 클릭 — 새 블록 생성. Ctrl 조합이면 선택만 해제하고 스킵.
                    if (up.ctrlKey || up.metaKey || up.shiftKey) return;
                    if (Date.now() - startClickTs > 400) return; // 오래 누른 건 클릭 아님
                    const durMin = 60;
                    const rawMin = Math.max(0, Math.round(((up.clientY - rect.top) / getRootZoom() / HOUR_H) * 60 / 15) * 15);
                    const startMin = Math.min(TOTAL_H * 60 - durMin, rawMin);
                    const endMin = startMin + durMin;
                    if (hasOverlapForDate(dateStr, startMin, endMin)) return;
                    const newBlock: Block = {
                      id: `b-${Date.now()}`,
                      title: "새 블록",
                      color: "#5AA9E6",
                      startH: Math.floor(startMin / 60),
                      startM: startMin % 60,
                      endH: Math.floor(endMin / 60),
                      endM: endMin % 60,
                      completed: false,
                      tags: [],
                      memo: "",
                      // category 누락 시 undefined 가 낙관적 상태에 남아 카테고리 색 매칭("" 기준)과
                      // 어긋날 수 있음 — DB 기본값과 동일하게 빈 문자열로 명시.
                      category: "",
                      date: dateStr,
                      // 시간표 블록은 기본으로 오늘 달성률에 포함하지 않음 (필요 시 상세 패널에서 켬).
                      countInCompletion: false,
                    };
                    setHoverSlot(null);
                    // 빈 영역 클릭은 선택 해제와 함께 새 블록 만들기
                    setSelectedIds(new Set());
                    onAddBlock(newBlock, { openInline: true });
                  };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                }}
                onMouseMove={e => {
                  if (dragTplId || dragBlockId || resizing || marquee) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const zoom = getRootZoom();
                  const rawMin = Math.max(0, Math.min(TOTAL_H * 60 - 15, Math.round(((e.clientY - rect.top) / zoom / HOUR_H) * 60 / 15) * 15));
                  setHoverSlot(prev => (prev?.dayIdx === di && prev.startMin === rawMin) ? prev : { dayIdx: di, startMin: rawMin });
                }}
                onMouseLeave={() => setHoverSlot(prev => (prev?.dayIdx === di ? null : prev))}
                onDragOver={e => {
                  // 시간표에는 시간 템플릿(templateId) 이나 시간 블록 이동(blockId/blockIds) 만 허용.
                  // 일정 템플릿(todoTemplateId) 이나 todo(todoId) 는 여기서 드랍 못 하게 preventDefault 스킵.
                  // ⚠ Chromium(WebView2) 은 dataTransfer.types 를 소문자로 정규화해서 돌려주므로
                  //    반드시 소문자로 비교해야 함. setData 는 케이스 무관하게 동작.
                  const types = e.dataTransfer.types;
                  if (
                    !types.includes("templateid") &&
                    !types.includes("blockid") &&
                    !types.includes("blockids")
                  ) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = dragBlockId ? "move" : "copy";
                  const rect = e.currentTarget.getBoundingClientRect();
                  // clientY/rect 는 CSS zoom(글씨 크기)이 반영된 시각 px — HOUR_H 와 맞추려면 zoom 으로 나눔.
                  const rawMin = Math.round((Math.max(0, e.clientY - rect.top) / getRootZoom() / HOUR_H) * 60 / 15) * 15;
                  // For block moves: anchor by offset so block follows mouse position
                  const anchoredMin = dragBlockId ? Math.max(0, rawMin - dragBlockOffsetMin) : rawMin;
                  const snapped = Math.round(anchoredMin / 15) * 15;
                  setDropTarget({ dayIdx: di, startH: Math.min(23, Math.floor(snapped / 60)), startM: snapped % 60 });
                }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
                onDrop={e => {
                  e.preventDefault();
                  if (!dropTarget || dropTarget.dayIdx !== di) { setDropTarget(null); setDragTplId(null); setDragBlockId(null); return; }

                  // ── 다중 블록 이동 (선택된 여러 블록을 함께 옮김) ──
                  // dataTransfer 에 blockIds 배열이 담겨 있으면 다중 이동. 앵커(primary) 블록 기준의
                  // 이동 벡터(dayDelta, minDelta) 를 계산한 뒤 각 블록에 그대로 적용.
                  const blockIdsData = e.dataTransfer.getData("blockIds");
                  const movedBlockId = e.dataTransfer.getData("blockId");
                  if (blockIdsData) {
                    try {
                      const ids: string[] = JSON.parse(blockIdsData);
                      const primary = blocksRef.current.find(b => b.id === movedBlockId);
                      if (primary) {
                        const primaryOrigStart = primary.startH * 60 + primary.startM;
                        const primaryNewStart = Math.max(0, dropTarget.startH * 60 + dropTarget.startM);
                        const minDelta = primaryNewStart - primaryOrigStart;
                        // dayDelta 는 primary 의 원본 date → dropTarget 의 dateStr 차이(일수)
                        const origDate = parseLocalDate(primary.date);
                        const targetDate = parseLocalDate(dateStr);
                        const dayDelta = Math.round((targetDate.getTime() - origDate.getTime()) / 86400000);
                        const moves = ids.map(id => {
                          const b = blocksRef.current.find(x => x.id === id);
                          if (!b) return null;
                          const bOrigStart = b.startH * 60 + b.startM;
                          const bDate = parseLocalDate(b.date);
                          bDate.setDate(bDate.getDate() + dayDelta);
                          return { id, newDate: toDateStr(bDate), newStartMin: bOrigStart + minDelta };
                        }).filter((m): m is { id: string; newDate: string; newStartMin: number } => m !== null);
                        onBulkMove(moves);
                      }
                    } catch (err) { console.error("bulk move parse failed", err); }
                    // 벌크 이동이 끝나면 유령 마퀴가 남지 않도록 방어 클리어 —
                    // HTML5 dragend 로 mouseup 이 억제되는 경우에 대비.
                    setMarquee(null);
                    setDropTarget(null); setDragBlockId(null); return;
                  }

                  // ── Moving an existing block (single) ──
                  if (movedBlockId) {
                    const block = blocksRef.current.find(b => b.id === movedBlockId);
                    if (block) {
                      const dur = block.endH * 60 + block.endM - (block.startH * 60 + block.startM);
                      const newStart = Math.max(0, dropTarget.startH * 60 + dropTarget.startM);
                      const newEnd = Math.min(TOTAL_H * 60, newStart + dur);
                      const adjustedStart = newEnd === TOTAL_H * 60 ? TOTAL_H * 60 - dur : newStart;
                      if (!hasOverlapForDate(dateStr, adjustedStart, adjustedStart + dur, movedBlockId)) {
                        // 원 위치 캡처해서 Ctrl+Z 로 되돌릴 수 있게.
                        const prev = { date: block.date, startH: block.startH, startM: block.startM, endH: block.endH, endM: block.endM };
                        onUpdateBlock(movedBlockId, {
                          date: dateStr,
                          startH: Math.floor(adjustedStart / 60), startM: adjustedStart % 60,
                          endH: Math.floor((adjustedStart + dur) / 60), endM: (adjustedStart + dur) % 60,
                        });
                        pushUndo(() => onUpdateBlock(movedBlockId, prev));
                      }
                    }
                    setMarquee(null);
                    setDropTarget(null); setDragBlockId(null); return;
                  }

                  // ── Dropping a category (통합 카테고리) ──
                  // 시간 그리드에 카테고리를 놓으면 그 카테고리로 새 블록을 만들되 제목은 비워
                  // 상세 패널이 자동으로 열리며 편집 상태로 시작. 색상은 렌더링 시 카테고리에서 자동 조회.
                  const tpl = templates.find(t => t.id === e.dataTransfer.getData("templateId"));
                  if (!tpl) { setDropTarget(null); setDragTplId(null); return; }
                  const sMin = dropTarget.startH * 60 + dropTarget.startM;
                  const eMin = Math.min(TOTAL_H * 60, sMin + 60);
                  if (!hasOverlapForDate(dateStr, sMin, eMin)) {
                    onAddBlock({ id: `b-${Date.now()}`, title: "새 블록", color: tpl.color, category: tpl.title,
                      startH: dropTarget.startH, startM: dropTarget.startM,
                      endH: Math.floor(eMin / 60), endM: eMin % 60,
                      completed: false, tags: [], memo: "", date: dateStr, countInCompletion: false },
                      { openInline: true });
                  }
                  setDropTarget(null); setDragTplId(null);
                }}
              >
                {Array.from({ length: TOTAL_H }, (_, h) => (
                  <div key={h} className="absolute w-full border-t border-border/40 pointer-events-none" style={{ top: h * HOUR_H }} />
                ))}

                {/* Hover ghost — 마우스 올린 15분 스냅 위치에 새 블록이 놓일 자리 미리보기.
                    이미 블록이 있는 시간대나 드래그·리사이즈 중일 땐 숨김. */}
                {hoverSlot?.dayIdx === di && !isDropTarget && !dragBlockId && !dragTplId && !resizing && !marquee
                  && !hasOverlapForDate(dateStr, hoverSlot.startMin, hoverSlot.startMin + 60) && (
                  <div
                    className="absolute left-0.5 right-0.5 rounded-lg pointer-events-none z-[6] bg-primary/5 ring-1 ring-primary/25"
                    style={{
                      top: hoverSlot.startMin / 60 * HOUR_H,
                      height: HOUR_H - 2,
                      boxShadow: "0 6px 16px -6px rgba(90, 169, 230, 0.35), 0 2px 6px -2px rgba(90, 169, 230, 0.25)",
                    }}
                  >
                    <div className="text-[10px] text-primary/70 px-1.5 pt-1 font-medium">+ 새 블록</div>
                    <div className="text-[9px] text-primary/50 px-1.5 mt-0.5">
                      {fmtTime(Math.floor(hoverSlot.startMin / 60), hoverSlot.startMin % 60)}
                      {" – "}
                      {fmtTime(Math.floor((hoverSlot.startMin + 60) / 60), (hoverSlot.startMin + 60) % 60)}
                    </div>
                  </div>
                )}

                {/* Drop ghost — template or single block move (primary 만) */}
                {isDropTarget && ghostStartMin !== null && (dragTemplate || dragBlock) && (() => {
                  const src = dragBlock ?? dragTemplate!;
                  const ghostDur = dragBlock ? (dragBlock.endH*60+dragBlock.endM) - (dragBlock.startH*60+dragBlock.startM) : 60;
                  const gEnd = Math.min(TOTAL_H * 60, ghostStartMin + ghostDur);
                  const gTop = ghostStartMin / 60 * HOUR_H;
                  const gH = Math.max(20, (gEnd - ghostStartMin) / 60 * HOUR_H - 2);
                  const overlap = hasOverlapForDate(dateStr, ghostStartMin, gEnd, dragBlock?.id);
                  // src.color: 블록이면 카테고리 색 조회, 템플릿이면 자체 색 그대로.
                  const srcColor = dragBlock ? getCategoryColor(templates, dragBlock.category) : (src as any).color;
                  return (
                    <div className="absolute left-0.5 right-0.5 rounded-lg px-1.5 py-1 pointer-events-none border-2 border-dashed z-20"
                      style={{ top: gTop, height: gH,
                        backgroundColor: overlap ? "#ef444418" : srcColor + "20",
                        borderColor: overlap ? "#ef4444" : srcColor }}>
                      <div className="text-[10px] font-semibold truncate" style={{ color: overlap ? "#ef4444" : srcColor }}>
                        {overlap ? "⚠ 이미 일정이 있습니다" : src.title}
                      </div>
                      {!overlap && (
                        <div className="text-[9px] opacity-60 mt-0.5" style={{ color: srcColor }}>
                          {fmtTime(Math.floor(ghostStartMin/60), ghostStartMin%60)} – {fmtTime(Math.floor(gEnd/60), gEnd%60)}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* 다중 드래그 고스트 — primary 블록의 (dayDelta, minDelta) 로 selectedIds 각각의
                     착지 위치를 계산해서 각 요일 컬럼에 그림. primary 자신은 위쪽 단일 고스트가
                     이미 그리므로 여기선 primary 제외한 나머지만. */}
                {dropTarget && dragBlockId && selectedIds.size > 1 && selectedIds.has(dragBlockId) && (() => {
                  const primary = blocksRef.current.find(b => b.id === dragBlockId);
                  if (!primary) return null;
                  const primaryOrigStart = primary.startH * 60 + primary.startM;
                  const primaryNewStart = dropTarget.startH * 60 + dropTarget.startM;
                  const minDelta = primaryNewStart - primaryOrigStart;
                  const primaryOrigDate = parseLocalDate(primary.date);
                  const primaryTargetDateStr = days[dropTarget.dayIdx] ? toDateStr(days[dropTarget.dayIdx]) : null;
                  if (!primaryTargetDateStr) return null;
                  const dayDelta = Math.round((parseLocalDate(primaryTargetDateStr).getTime() - primaryOrigDate.getTime()) / 86400000);
                  const ghosts: React.ReactNode[] = [];
                  selectedIds.forEach(id => {
                    if (id === dragBlockId) return; // primary 는 위에서 그림
                    const b = blocksRef.current.find(x => x.id === id);
                    if (!b) return;
                    const bDate = parseLocalDate(b.date);
                    bDate.setDate(bDate.getDate() + dayDelta);
                    if (toDateStr(bDate) !== dateStr) return; // 이 컬럼에 안 떨어짐
                    const bOrigStart = b.startH * 60 + b.startM;
                    const bDur = (b.endH * 60 + b.endM) - bOrigStart;
                    const bNewStart = Math.max(0, Math.min(TOTAL_H * 60 - bDur, bOrigStart + minDelta));
                    const bNewEnd = bNewStart + bDur;
                    const bTop = bNewStart / 60 * HOUR_H;
                    const bH = Math.max(20, bDur / 60 * HOUR_H - 2);
                    const bOverlap = hasOverlapForDate(dateStr, bNewStart, bNewEnd, id);
                    const bColor = getCategoryColor(templates, b.category);
                    ghosts.push(
                      <div key={`gh-${id}`} className="absolute left-0.5 right-0.5 rounded-lg px-1.5 py-1 pointer-events-none border-2 border-dashed z-20"
                        style={{ top: bTop, height: bH,
                          backgroundColor: bOverlap ? "#ef444418" : bColor + "20",
                          borderColor: bOverlap ? "#ef4444" : bColor }}>
                        <div className="text-[10px] font-semibold truncate" style={{ color: bOverlap ? "#ef4444" : bColor }}>
                          {bOverlap ? "⚠" : b.title}
                        </div>
                      </div>
                    );
                  });
                  return <>{ghosts}</>;
                })()}

                {/* 습관 스태킹 연결선은 제거됨 — 관련 기능이 상세 패널에서 삭제되었기 때문에
                    UI 표시도 함께 제거. 데이터베이스의 next_block_id 컬럼은 호환용으로 유지. */}

                {/* Blocks */}
                {dayBlocks.map(block => {
                  const sMin = block.startH * 60 + block.startM;
                  const eMin = block.endH * 60 + block.endM;
                  const top = sMin / 60 * HOUR_H;
                  const height = Math.max(20, (eMin - sMin) / 60 * HOUR_H - 2);
                  const isBeingDragged = dragBlockId === block.id;
                  const isSelected = selectedIds.has(block.id);
                  const color = getCategoryColor(templates, block.category);
                  return (
                    <div key={block.id}
                      draggable
                      onDragStart={e => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        // 블록 안에서 잡은 지점(분) — CSS zoom(글씨 크기) 보정해야 드랍 시 앵커가 안 어긋남.
                        const offsetPx = (e.clientY - rect.top) / getRootZoom();
                        const offsetMin = Math.round((offsetPx / HOUR_H) * 60 / 15) * 15;
                        e.dataTransfer.setData("blockId", block.id);
                        e.dataTransfer.setData("blockOffsetMin", String(offsetMin));
                        // 다중 선택 상태이고 이 블록이 그 안에 있으면 selectedIds 전체를 함께 옮김.
                        // 아니라면 단일 이동으로 동작. (선택돼 있지 않은 블록을 드래그하면 그 하나만.)
                        if (isSelected && selectedIds.size > 1) {
                          e.dataTransfer.setData("blockIds", JSON.stringify(Array.from(selectedIds)));
                        }
                        e.dataTransfer.effectAllowed = "move";
                        setDragBlockId(block.id);
                        setDragBlockOffsetMin(offsetMin);
                        // 블록 드래그가 시작되면 그 사이 잘못 켜졌을 수 있는 마퀴 상태를 방어적으로 해제.
                        // HTML5 dragend 는 mouseup 을 억제하므로 마퀴가 mouseup 으로 자연 종료되지 않아
                        // 유령 상태로 남아있는 것을 원천 차단.
                        setMarquee(null);
                      }}
                      onDragEnd={() => { setDragBlockId(null); setDropTarget(null); setMarquee(null); }}
                      onContextMenu={e => {
                        e.preventDefault();
                        // 선택되지 않은 블록을 우클릭하면 그 블록만 선택 상태로 두고 메뉴 노출.
                        if (!isSelected) setSelectedIds(new Set([block.id]));
                        setCtxMenu({ x: e.clientX, y: e.clientY });
                      }}
                      className={`absolute left-0.5 right-0.5 rounded-lg overflow-hidden z-10 select-none group/block ${resizing?.blockId !== block.id && !isBeingDragged ? "cursor-grab hover:brightness-95" : ""} ${isBeingDragged ? "opacity-30" : ""} ${isSelected ? "ring-2 ring-primary ring-offset-1" : ""}`}
                      style={{ top, height, backgroundColor: color + "28", borderLeft: `3px solid ${color}`, opacity: block.completed ? 0.45 : isBeingDragged ? 0.3 : 1 }}
                      onClick={e => {
                        if (resizing || dragBlockId || justResizedRef.current) return;
                        e.stopPropagation();
                        // Ctrl/⌘+클릭: 선택 토글, 상세 패널은 열지 않음.
                        if (e.ctrlKey || e.metaKey) {
                          setSelectedIds(prev => {
                            const next = new Set(prev);
                            if (next.has(block.id)) next.delete(block.id); else next.add(block.id);
                            return next;
                          });
                          return;
                        }
                        // 일반 클릭: 다른 선택은 해제하고 이 블록만 선택 + 상세 패널.
                        setSelectedIds(new Set());
                        onSelect(block);
                      }}
                    >
                      <div className="absolute top-0 left-0 right-0 h-2.5 cursor-n-resize z-20"
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                          setResizing({ blockId: block.id, edge: "top", startY: e.clientY, origStartMin: sMin, origEndMin: eMin, blockDate: block.date }); }} />
                      {/* 텍스트 컨테이너를 세로 중앙 배치 — 리사이즈 핸들(위/아래 2.5px씩)을 피해서
                           inset-y-2.5 로 채우고, flex column + justify-center 로 실제 텍스트를 중앙 정렬. */}
                      <div className="absolute inset-x-0 inset-y-2.5 px-1.5 flex flex-col justify-center min-w-0">
                        <div className="text-[10px] font-semibold truncate flex items-center gap-1" style={{ color }}>
                          {block.repeatGroupId && <span title="반복 일정" style={{ fontSize: 9 }}>↻</span>}
                          <span className="truncate">{block.title}</span>
                        </div>
                        {height > 32 && (
                          <div className="text-[9px] opacity-70 mt-0.5 truncate" style={{ color }}>
                            {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
                          </div>
                        )}
                      </div>
                      {/* Delete button on hover */}
                      <button
                        onClick={e => { e.stopPropagation(); onDeleteBlock(block.id); }}
                        className="absolute top-1 right-1 size-4 rounded flex items-center justify-center opacity-0 group-hover/block:opacity-100 hover:bg-black/20 transition-opacity z-30"
                        title="블록 삭제"
                      >
                        <X size={9} style={{ color }} />
                      </button>
                      <div className="absolute bottom-0 left-0 right-0 h-2.5 cursor-s-resize z-20"
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                          setResizing({ blockId: block.id, edge: "bottom", startY: e.clientY, origStartMin: sMin, origEndMin: eMin, blockDate: block.date }); }} />
                    </div>
                  );
                })}

                {/* 마퀴 선택 사각형은 그리드 레벨(timeGridRef 자식)로 이동됨 —
                     여러 컬럼을 가로지르고 스크롤/세로 클립 없이 렌더되도록. */}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // ── Month grid renderer ─────────────────────────────────────────
  const renderMonthGrid = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = [
      ...Array(firstDow).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
    ];
    while (cells.length % 7 !== 0) cells.push(null);
    const totalRows = cells.length / 7;

    return (
      /* 월 뷰는 스크롤 없이 남은 공간을 꽉 채움. 각 셀 높이는 (총높이 - 요일헤더) / totalRows 로
         균등 분배 — 글씨 크기(html zoom) 를 바꿔도 flex/1fr 이 zoom 좌표계 안에서 재계산되므로
         자동으로 화면에 맞게 조정됨. */
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
        {/* Day of week headers — 좌우 끝에 이전/다음 화살표를 겹쳐 얹어 네비게이션. */}
        <div className="relative grid grid-cols-7 border-b border-border flex-shrink-0 bg-card">
          {["일","월","화","수","목","금","토"].map((d, i) => (
            <div key={d} className={`text-center text-[10px] py-2 font-medium ${i===0?"text-red-400":i===6?"text-blue-400":"text-muted-foreground"}`}>{d}</div>
          ))}
          <button
            onClick={goPrev}
            className="absolute left-0 top-0 bottom-0 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            title="이전 달"
          ><ChevronLeft size={14} /></button>
          <button
            onClick={goNext}
            className="absolute right-0 top-0 bottom-0 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            title="다음 달"
          ><ChevronRight size={14} /></button>
        </div>

        <div
          className="grid grid-cols-7 flex-1 min-h-0"
          style={{ gridTemplateRows: `repeat(${totalRows}, minmax(0, 1fr))` }}
        >
          {cells.map((day, i) => {
            if (!day) return (
              <div key={`e-${i}`} className={`min-h-0 overflow-hidden bg-muted/5 ${i%7!==6?"border-r":""} ${Math.floor(i/7)<totalRows-1?"border-b":""} border-border`} />
            );
            const dateStr = toDateStr(day);
            const isToday = dateStr === TODAY_STR;
            const isFuture = dateStr > TODAY_STR;
            const col = i % 7;
            const row = Math.floor(i / 7);
            const dayDeadlines = deadlines.filter(d => d.dueDate === dateStr);
            // multi-day todo 는 date~endDate 범위 안에 있는 셀에도 표시. 카테고리 기준 정렬.
            const dayTodos = sortTodosByCategory(
              todos.filter(t => t.date === dateStr || (t.endDate && dateStr >= t.date && dateStr <= t.endDate))
            );
            // 시간표 블록 — 좁은 월 셀이 도배되지 않도록 달성률 포함(countInCompletion=true) 블록만 표시.
            // 자유시간/이동 같은 통계 제외 블록은 월 뷰에서도 감춤. 시작 시각 기준 정렬.
            const dayBlocks = blocks
              .filter(b => b.date === dateStr && b.countInCompletion !== false)
              .sort((a, b) => (a.startH * 60 + a.startM) - (b.startH * 60 + b.startM));
            const monthAddDraft = monthDrafts[dateStr] ?? "";

            const showHoverGhost = monthHoverDate === dateStr && monthEditing !== dateStr;
            return (
              <div key={dateStr}
                onMouseEnter={() => setMonthHoverDate(dateStr)}
                onMouseLeave={() => setMonthHoverDate(prev => prev === dateStr ? null : prev)}
                className={`min-h-0 min-w-0 overflow-hidden p-1.5 relative flex flex-col ${col!==6?"border-r border-border":""} ${row<totalRows-1?"border-b border-border":""} ${isToday?"ring-1 ring-inset ring-primary/40":""} ${isFuture?"bg-muted/5":""}`}
                onClick={e => {
                  // 셀 배경 직접 클릭 → 새 todo 인라인 입력 오픈.
                  if (e.target !== e.currentTarget) return;
                  setMonthEditing(dateStr);
                }}
              >
                <div className="flex items-center justify-start mb-1 gap-1.5 min-w-0">
                  <span
                    onClick={e => { e.stopPropagation(); setViewDate(day); setCalView("day"); }}
                    className={`text-xs font-medium inline-flex items-center justify-center leading-none cursor-pointer hover:opacity-70 transition-opacity flex-shrink-0 ${isToday?"size-5 rounded-full bg-primary text-primary-foreground text-[10px]":isHoliday(dateStr)||col===0?"text-red-400":col===6?"text-blue-400":"text-muted-foreground"}`}
                    title={getHoliday(dateStr) ? `${getHoliday(dateStr)} — 이 날짜 일 캘린더로 이동` : "이 날짜 일 캘린더로 이동"}
                  >
                    {day.getDate()}
                  </span>
                  {/* 공휴일이면 이름을 날짜 옆에 작게 표시 — 좁은 셀이라 truncate 로 넘침 방지. */}
                  {getHoliday(dateStr) && (
                    <span className="text-[9px] text-red-400 font-medium truncate min-w-0" title={getHoliday(dateStr) ?? ""}>
                      {getHoliday(dateStr)}
                    </span>
                  )}
                </div>
                {/* 마감(최상단) — 남은 일수 톤 + D-day 배지. 왼쪽 스트라이프 형태는 시간 블록과 동일. */}
                {dayDeadlines.length > 0 && (
                  <div className="space-y-0.5 mb-0.5">
                    {dayDeadlines.map(d => {
                      const daysLeft = daysBetween(parseLocalDate(d.dueDate), TODAY_DATE);
                      // 블록 색은 커스텀 우선, 없으면 D-day 톤. D-day 배지는 항상 D-day 톤.
                      const dayColor = deadlineToneHex(daysLeft);
                      const blockColor = d.color || dayColor;
                      return (
                        <div
                          key={d.id}
                          onClick={e => { e.stopPropagation(); onSelectDeadline?.(d); }}
                          className={`rounded overflow-hidden text-[9px] cursor-pointer transition-colors flex items-center gap-1 pr-1 ${d.completed ? "opacity-60" : "hover:brightness-95"}`}
                          style={{ backgroundColor: blockColor + "28", borderLeft: `3px solid ${blockColor}` }}
                          title="클릭: 상세 열기"
                        >
                          <span
                            className={`truncate font-medium leading-tight px-1 py-0.5 flex-1 min-w-0 ${d.completed ? "line-through" : ""}`}
                            style={{ color: blockColor }}
                          >{d.title}</span>
                          <span className="text-[8px] font-semibold leading-none flex-shrink-0" style={{ color: dayColor }}>
                            {formatDDay(daysLeft)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* 시간표 블록 — 마감 아래, 할 일 위. 좁은 셀이 도배되지 않도록 달성률 포함 블록만.
                     시작 시각 prefix (HH:MM) 로 할 일과 시각적으로 구분. 카테고리 색으로 좌측 스트라이프. */}
                {dayBlocks.length > 0 && (
                  <div className="space-y-0.5 mb-0.5">
                    {dayBlocks.map(b => {
                      const color = getCategoryColor(templates, b.category);
                      const hh = String(b.startH).padStart(2, "0");
                      const mm = String(b.startM).padStart(2, "0");
                      return (
                        <div key={b.id}
                          onClick={e => { e.stopPropagation(); onSelect(b); }}
                          className={`rounded overflow-hidden text-[9px] cursor-pointer transition-all ${b.completed ? "opacity-60" : "hover:brightness-95"}`}
                          style={{ backgroundColor: color + "28", borderLeft: `3px solid ${color}` }}
                          title={`${hh}:${mm} ${b.title || "제목 없음"}`}
                        >
                          <span
                            className={`truncate leading-tight block px-1 py-0.5 font-medium ${b.completed ? "line-through" : ""}`}
                            style={{ color }}
                          >
                            <span className="opacity-70 mr-1">{hh}:{mm}</span>
                            {b.title}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Todo — 마감 아래. 시간 블록과 동일한 왼쪽 색 스트라이프 + 배경 톤.
                     클릭 → 상세 패널 (색상/메모 편집). 시간 블록과 동일한 인터랙션.
                     카테고리는 제목 앞에 소형 라벨로. 월 뷰 셀은 좁아서 메모 프리뷰는 생략. */}
                <div className="space-y-0.5">
                  {dayTodos.map(t => {
                    const color = getCategoryColor(templates, t.category);
                    return (
                    <div key={t.id}
                      onClick={e => { e.stopPropagation(); onSelectTodo?.(t); }}
                      className={`rounded overflow-hidden text-[9px] cursor-pointer transition-all ${t.completed ? "opacity-60" : "hover:brightness-95"}`}
                      style={{ backgroundColor: color + "28", borderLeft: `3px solid ${color}` }}
                      title={t.category ? `[${t.category}] 상세 열기` : "상세 열기"}
                    >
                      <span
                        className={`truncate leading-tight block px-1 py-0.5 font-medium ${t.completed ? "line-through" : ""}`}
                        style={{ color }}
                      >
                        {t.category && (
                          <span className="opacity-70 mr-1">[{t.category}]</span>
                        )}
                        {t.title}
                      </span>
                    </div>
                    );
                  })}
                </div>
                {/* 새 todo 인라인 입력 — 셀 클릭으로 열리며 Enter/Escape/blur 로 확정/취소 */}
                {monthEditing === dateStr && (
                  <input
                    autoFocus
                    value={monthAddDraft}
                    onChange={e => setMonthDrafts(d => ({ ...d, [dateStr]: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        const v = (monthDrafts[dateStr] ?? "").trim();
                        if (v) onAddTodo({ title: v, date: dateStr });
                        setMonthDrafts(d => ({ ...d, [dateStr]: "" }));
                        setMonthEditing(null);
                      } else if (e.key === "Escape") {
                        setMonthDrafts(d => ({ ...d, [dateStr]: "" }));
                        setMonthEditing(null);
                      }
                    }}
                    onBlur={() => {
                      const v = (monthDrafts[dateStr] ?? "").trim();
                      if (v) onAddTodo({ title: v, date: dateStr });
                      setMonthDrafts(d => ({ ...d, [dateStr]: "" }));
                      setMonthEditing(null);
                    }}
                    placeholder="새 일정"
                    className="mt-1 w-full px-1 py-0.5 rounded text-[9px] bg-transparent border border-primary/40 outline-none placeholder:text-muted-foreground/60"
                  />
                )}
                {/* Hover ghost — 셀에 마우스 올리면 "새 일정 추가" 프리뷰가 그림자와 함께 뜸.
                     click 은 부모 셀로 버블 → monthEditing 열림. */}
                {showHoverGhost && (
                  <div
                    onClick={e => { e.stopPropagation(); setMonthEditing(dateStr); }}
                    className="mt-1 flex items-center gap-1 px-1 py-0.5 rounded text-[9px] bg-card border border-dashed border-primary/40 text-muted-foreground/80 shadow-md cursor-pointer hover:text-primary hover:border-primary/70 transition-colors pointer-events-auto"
                    title="이 날짜에 새 일정 추가"
                  >
                    <Plus size={9} /> <span className="truncate">새 일정</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── List view ───────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Header — 3분할: 좌(뷰 세그먼트) · 중앙(날짜 라벨 양옆 chevron) · 우(리스트/그리드 + 콘텐츠 모드) */}
      <div className="flex items-center px-5 py-3 border-b border-border flex-shrink-0 bg-card/50">
        <div className="flex-1 flex items-center gap-3">
          <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5">
            {(["day","week","month"] as const).map(v => (
              <button key={v} onClick={() => setCalView(v)}
                className={`px-3 py-1 text-xs rounded-md transition-all ${calView===v?"bg-card shadow-sm font-medium":"text-muted-foreground hover:text-foreground"}`}>
                {v==="day"?"일":v==="week"?"주":"월"}
              </button>
            ))}
          </div>
        </div>
        {/* 중앙: 날짜 라벨. 클릭하면 연/월 점프 팝오버가 열려 화살표로 한 칸씩 옮기지 않고
             원하는 연·월로 바로 이동. 위치 계산 단순화를 위해 relative 컨테이너 안에 absolute 팝오버. */}
        <div className="flex items-center relative" ref={monthPickerRef}>
          <button
            onClick={() => {
              setMonthPickerYear(viewDate.getFullYear());
              setMonthPickerMonth(viewDate.getMonth());
              setMonthPickerOpen(v => !v);
            }}
            className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors min-w-[180px] text-center"
            title={calView === "month" ? "연·월 바로 이동" : calView === "week" ? "연·월·주 바로 이동" : "연·월·일 바로 이동"}
          >
            {headerLabel}
          </button>
          {monthPickerOpen && (
            <div className={`absolute top-full left-1/2 -translate-x-1/2 mt-1 z-40 rounded-lg border border-border bg-card shadow-lg p-3 ${calView === "month" ? "w-64" : "w-72"}`}>
              {/* 연도 조절 — 화살표로 ±1, 가운데 숫자 클릭하면 올해로 리셋. */}
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => setMonthPickerYear(y => y - 1)}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="이전 해"
                ><ChevronLeft size={14} /></button>
                <button
                  onClick={() => setMonthPickerYear(TODAY_DATE.getFullYear())}
                  className="text-sm font-semibold hover:text-primary transition-colors"
                  title="올해로"
                >{monthPickerYear}년</button>
                <button
                  onClick={() => setMonthPickerYear(y => y + 1)}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="다음 해"
                ><ChevronRight size={14} /></button>
              </div>
              {/* 3×4 월 그리드.
                 - 월 뷰: 클릭 즉시 해당 월로 점프하고 팝오버 닫음.
                 - 일/주 뷰: 클릭하면 아래 일 그리드가 그 달로 바뀔 뿐 아직 이동하지 않음. */}
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 12 }, (_, i) => i).map(mi => {
                  const isCurrentView = monthPickerYear === viewDate.getFullYear() && mi === viewDate.getMonth();
                  const isToday = monthPickerYear === TODAY_DATE.getFullYear() && mi === TODAY_DATE.getMonth();
                  const isPickerMonth = calView !== "month" && mi === monthPickerMonth;
                  return (
                    <button
                      key={mi}
                      onClick={() => {
                        if (calView === "month") {
                          setViewDate(new Date(monthPickerYear, mi, 1));
                          setMonthPickerOpen(false);
                        } else {
                          setMonthPickerMonth(mi);
                        }
                      }}
                      className={`px-2 py-1.5 text-xs rounded-md transition-colors ${
                        isCurrentView
                          ? "bg-primary text-primary-foreground font-medium"
                          : isPickerMonth
                            ? "bg-muted font-medium text-foreground"
                            : isToday
                              ? "ring-1 ring-inset ring-primary/40 hover:bg-muted"
                              : "hover:bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >{mi + 1}월</button>
                  );
                })}
              </div>
              {/* 일/주 뷰에서만 뜨는 일 그리드 — 원하는 날짜/주로 바로 이동.
                 주 뷰에선 그 날이 포함된 주(getWeekDays) 로, 일 뷰에선 그 날로 이동. */}
              {calView !== "month" && (() => {
                const firstDow = new Date(monthPickerYear, monthPickerMonth, 1).getDay();
                const daysInMonth = new Date(monthPickerYear, monthPickerMonth + 1, 0).getDate();
                const cells: Array<number | null> = [
                  ...Array<null>(firstDow).fill(null),
                  ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
                ];
                while (cells.length % 7 !== 0) cells.push(null);
                // 주 뷰에서 현재 보고 있는 주에 속한 날짜들(YYYY-MM-DD) — 강조 배경용.
                const currentWeekDates = calView === "week"
                  ? new Set(getWeekDays(viewDate).map(d => toDateStr(d)))
                  : new Set<string>();
                const currentDayStr = calView === "day" ? toDateStr(viewDate) : "";
                return (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="grid grid-cols-7 gap-0.5 mb-1">
                      {["일","월","화","수","목","금","토"].map((d, i) => (
                        <div key={d} className={`text-[10px] text-center py-0.5 font-medium ${i===0?"text-red-400":i===6?"text-blue-400":"text-muted-foreground"}`}>{d}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-0.5">
                      {cells.map((day, idx) => {
                        if (!day) return <div key={`e-${idx}`} />;
                        const cellDate = new Date(monthPickerYear, monthPickerMonth, day);
                        const cellStr = toDateStr(cellDate);
                        const isSelected = calView === "day"
                          ? cellStr === currentDayStr
                          : currentWeekDates.has(cellStr);
                        const isTodayCell = cellStr === TODAY_STR;
                        const col = idx % 7;
                        const holiday = isHoliday(cellStr);
                        return (
                          <button
                            key={idx}
                            onClick={() => {
                              setViewDate(cellDate);
                              setMonthPickerOpen(false);
                            }}
                            title={getHoliday(cellStr) ?? undefined}
                            className={`text-[11px] py-1 rounded transition-colors ${
                              isSelected
                                ? "bg-primary/15 text-primary font-medium"
                                : isTodayCell
                                  ? "ring-1 ring-inset ring-primary/40 hover:bg-muted"
                                  : "hover:bg-muted"
                            } ${
                              isSelected ? "" : (holiday || col === 0) ? "text-red-400" : col === 6 ? "text-blue-400" : "text-foreground"
                            }`}
                          >{day}</button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              <button
                onClick={() => { setViewDate(TODAY_DATE); setMonthPickerOpen(false); }}
                className="mt-3 w-full px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition-colors"
              >{calView === "day" ? "오늘로" : calView === "week" ? "이번 주로" : "이번 달로"}</button>
            </div>
          )}
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          {calView !== "month" && (
            /* 시간표 ↔ 할 일 ↔ 둘 다 순서로 순환하는 단일 토글 버튼.
               활성 표시는 개별 span 배경 대신 절대 위치 인디케이터 하나로 —
               둘 다 활성일 때 라벨 사이 gap 이 구분선처럼 보이던 문제를 없애고,
               상태 전환 시 left/width 트랜지션으로 자연스럽게 이동/신축. */
            (() => {
              const gridOn = contentView === "grid" || contentView === "both";
              const todosOn = contentView === "todos" || contentView === "both";
              const cycle = () => {
                if (contentView === "grid") setContentView("todos");
                else if (contentView === "todos") setContentView("both");
                else setContentView("grid");
              };
              // 인디케이터 위치/폭 — grid: 왼쪽 절반 / todos: 오른쪽 절반 / both: 전체.
              // 트랙 안쪽 2px 패딩만큼 좌우로 여백을 남겨 인디케이터가 트랙에 딱 붙지 않게.
              const indicator: React.CSSProperties = contentView === "grid"
                ? { left: 2, width: "calc(50% - 2px)" }
                : contentView === "todos"
                ? { left: "50%", width: "calc(50% - 2px)" }
                : { left: 2, width: "calc(100% - 4px)" };
              return (
                <button
                  onClick={cycle}
                  className="relative inline-flex items-center rounded-full bg-muted h-7 w-[140px] hover:bg-muted/80 transition-colors overflow-hidden"
                  title="시간표 → 할 일 → 둘 다 순환"
                >
                  <span
                    aria-hidden
                    className="absolute top-0.5 bottom-0.5 rounded-full bg-card shadow-sm transition-[left,width] duration-200 ease-out"
                    style={indicator}
                  />
                  <span className={`relative z-10 flex-1 text-center text-[11px] transition-colors ${gridOn ? "font-medium text-foreground" : "text-muted-foreground"}`}>시간표</span>
                  <span className={`relative z-10 flex-1 text-center text-[11px] transition-colors ${todosOn ? "font-medium text-foreground" : "text-muted-foreground"}`}>할 일</span>
                </button>
              );
            })()
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Template panel */}
        <div className={`border-r border-border flex-shrink-0 flex flex-col bg-sidebar transition-all duration-200 ${templateOpen?"w-44":"w-9"}`}>
          <button onClick={() => setTemplateOpen(!templateOpen)}
            className="flex items-center justify-between w-full px-3 py-3 border-b border-sidebar-border hover:bg-sidebar-accent transition-colors">
            {templateOpen && <span className="text-[11px] font-medium text-muted-foreground">템플릿</span>}
            <ChevronLeft size={13} className={`transition-transform text-muted-foreground mx-auto ${!templateOpen?"rotate-180":""}`} />
          </button>
          {templateOpen && (
            <div className="p-2 space-y-0.5 overflow-y-auto flex-1">
              {/* 카테고리 — 블록/할 일 공통. 시간 그리드에 드래그하면 그 카테고리의 새 블록,
                    할 일 컬럼에 드래그하면 그 카테고리의 새 할 일이 만들어짐. 색상은 카테고리 색을 자동 상속. */}
              {(
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground px-2 py-1 uppercase tracking-wide">카테고리</div>
                  {templates.map(t => (
                    <div key={t.id} draggable
                      onDragStart={e => {
                        // 시간 그리드는 templateId 를 소비하고, 할 일 컬럼은 todoCategory 를 소비.
                        // 두 키를 같이 실어 어느 쪽으로 드롭해도 동작하게 함.
                        e.dataTransfer.setData("templateId", t.id);
                        e.dataTransfer.setData("todoTemplateId", t.id);
                        e.dataTransfer.setData("todoCategory", t.title);
                        e.dataTransfer.effectAllowed = "copy";
                        const rect = e.currentTarget.getBoundingClientRect();
                        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - rect.left, e.clientY - rect.top);
                        setDragTplId(t.id);
                      }}
                      onDragEnd={() => { setDragTplId(null); setDropTarget(null); }}
                      className="group/tpl flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sidebar-accent cursor-grab active:cursor-grabbing transition-colors text-xs select-none">
                      <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: t.color }} />
                      <span className="flex-1 truncate text-foreground/80">{t.title}</span>
                      <button
                        onClick={e => { e.stopPropagation(); onDeleteBlockTemplate(t.id); }}
                        onMouseDown={e => e.stopPropagation()}
                        onDragStart={e => { e.stopPropagation(); e.preventDefault(); }}
                        draggable={false}
                        title="카테고리 삭제 — 이 카테고리의 항목들은 미분류로 이동"
                        className="opacity-0 group-hover/tpl:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:text-destructive flex-shrink-0"
                      ><X size={11} /></button>
                    </div>
                  ))}
                  {showNewTpl === "todo" ? (
                    <div className="p-2 rounded-lg bg-sidebar-accent space-y-1.5">
                      <input
                        autoFocus
                        value={newTplTitle}
                        onChange={e => setNewTplTitle(e.target.value)}
                        placeholder="카테고리 이름..."
                        className="w-full text-xs px-2 py-1 rounded bg-card border border-border outline-none focus:ring-1 focus:ring-ring"
                      />
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {paletteColors.map(c => (
                          <div key={c} className="relative group/color size-5 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => setNewTplColor(c)}
                              className={`size-5 rounded-full transition-transform ${newTplColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-sidebar-accent ring-foreground/40 scale-110" : ""}`}
                              style={{ backgroundColor: c }}
                              title={c}
                            />
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                              className="absolute -top-1 -right-1 size-3 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                              title="팔레트에서 제거"
                            >
                              <X size={7} strokeWidth={2.5} />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setShowTplCustomColor(v => !v)}
                          className={`size-5 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showTplCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                          title="사용자 지정 색상 추가"
                        >
                          <Plus size={10} className={showTplCustomColor ? "text-primary" : "text-muted-foreground"} />
                        </button>
                      </div>
                      {showTplCustomColor && (
                        <CustomColorPickerInline
                          initial={newTplColor}
                          onAdd={(color) => { setNewTplColor(color); onAddPaletteColor(color); }}
                          onClose={() => setShowTplCustomColor(false)}
                        />
                      )}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => {
                            const name = newTplTitle.trim();
                            if (!name) return;
                            // 같은 이름의 카테고리가 이미 있으면 중복 생성 방지 — todos.category 매칭이
                            // 문자열 기반이라 두 카테고리가 같은 이름을 가지면 색 조회가 랜덤해짐.
                            if (templates.some(x => x.kind === "todo" && x.title === name)) {
                              setShowNewTpl(null);
                              return;
                            }
                            onAddTemplate({
                              title: name,
                              color: newTplColor,
                              tags: [],
                              kind: "todo",
                            });
                            setNewTplTitle(""); setShowNewTpl(null);
                          }}
                          disabled={!newTplTitle.trim()}
                          className="flex-1 text-[11px] py-1 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                        >추가</button>
                        <button onClick={() => setShowNewTpl(null)} className="flex-1 text-[11px] py-1 rounded-lg bg-muted hover:bg-muted/70 transition-colors">취소</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewTpl("todo")}
                      className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:text-foreground w-full rounded-lg hover:bg-sidebar-accent transition-colors"
                    >
                      <Plus size={11}/> 새 카테고리
                    </button>
                  )}
                </div>
              )}

            </div>
          )}
        </div>

        {/* Content — 뷰 종류(일/주/월) 와 콘텐츠 모드(시간 그리드/일정 리스트/둘 다) 조합.
             month 는 시간 그리드가 없어 항상 월 그리드로 렌더. 일/주 는 contentView 에 따라 분할. */}
        {calView === "month" ? (
          renderMonthGrid()
        ) : (
          <div ref={bothContainerRef} className="flex-1 flex flex-col overflow-hidden min-w-0">
            {contentView !== "todos" && (
              <div
                className="flex overflow-hidden min-h-0"
                style={contentView === "both" ? { flex: `${splitRatio} 1 0`, minHeight: 0 } : { flex: "1 1 0" }}
              >
                {renderTimeGrid(viewDays)}
              </div>
            )}
            {contentView === "both" && (
              /* 상·하 영역 사이 리사이즈 핸들. 마우스 다운 후 이동에 따라 splitRatio 갱신. */
              <div
                onMouseDown={startSplitterDrag}
                className="h-1.5 flex-shrink-0 bg-border/40 hover:bg-primary/40 active:bg-primary/60 cursor-row-resize transition-colors"
                title="드래그해서 크기 조절"
              />
            )}
            {contentView !== "grid" && (
              <div
                className="overflow-hidden min-h-0"
                style={contentView === "both" ? { flex: `${1 - splitRatio} 1 0`, minHeight: 0 } : { flex: "1 1 0" }}
              >
                <TodoPanel
                  todos={todos}
                  templates={templates}
                  todoChecklistItems={todoChecklistItems}
                  viewDays={viewDays}
                  paletteColors={paletteColors}
                  groupMode={todoGroupMode}
                  onChangeGroupMode={setTodoGroupMode}
                  onAdd={onAddTodo}
                  onAddTemplate={onAddTemplate}
                  onDelete={onDeleteTodo}
                  onUpdateTitle={onUpdateTodoTitle}
                  onSelectTodo={onSelectTodo}
                  onToggleTodo={onToggleTodo}
                  onChangeCategory={onUpdateTodoCategory}
                  deadlines={deadlines}
                  onToggleDeadline={onToggleDeadline}
                  onSelectDeadline={onSelectDeadline}
                  showDayHeader={contentView === "todos"}
                  onGoPrev={goPrev}
                  onGoNext={goNext}
                  onMoveTodo={(id, date) => onMoveTodo(id, date)}
                  onSwapTodo={onSwapTodo}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 다중 선택 상태에서 우클릭 시 뜨는 컨텍스트 메뉴 — 화면 절대 좌표 위치.
           바깥 클릭 리스너가 닫음(useEffect). mousedown 시 setCtxMenu(null) 이 발화하니
           메뉴 내부 클릭엔 stopPropagation 로 닫힘 방지. */}
      {ctxMenu && (
        /* 최대한 컴팩트하게 — 텍스트/아이콘 모두 축소. */
        <div
          onMouseDown={e => e.stopPropagation()}
          className="fixed z-50 min-w-[56px] bg-card border border-border rounded-md shadow-md p-0.5 text-[8px] leading-none"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <div className="px-1 py-0.5 text-[7px] text-muted-foreground tracking-wide">
            {selectedIds.size}개
          </div>
          <button
            onClick={() => { setShowMultiRepeat(true); setCtxMenu(null); }}
            className="w-full text-left px-1 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-1"
          >↻ 반복</button>
          <button
            onClick={() => {
              const picked = topLevelBlocks.filter(b => selectedIds.has(b.id));
              if (picked.length > 0) setBlockClipboard(picked);
              setCtxMenu(null);
            }}
            className="w-full text-left px-1 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-1"
          ><Copy size={8} /> 복사</button>
          <button
            onClick={() => {
              onPasteBlocks(blockClipboard, toDateStr(viewDate));
              setCtxMenu(null);
            }}
            disabled={blockClipboard.length === 0}
            className="w-full text-left px-1 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-1 disabled:opacity-40 disabled:hover:bg-transparent"
          ><Plus size={8} /> 붙임</button>
          <div className="h-px bg-border my-0.5" />
          <button
            onClick={() => {
              const ids = Array.from(selectedIds);
              onBulkDelete(ids);
              setSelectedIds(new Set());
              setCtxMenu(null);
            }}
            className="w-full text-left px-1 py-0.5 rounded hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-1"
          ><Trash2 size={8} /> 삭제</button>
        </div>
      )}

      {/* 다중 반복 설정 모달 — 우클릭 → "반복 설정" 이 열림. 규칙 확정하면 선택된 모든 블록에
           각각 setBlockRepeat 이 걸림. */}
      {showMultiRepeat && (
        <MultiRepeatModal
          count={selectedIds.size}
          onClose={() => setShowMultiRepeat(false)}
          onApply={(repeat) => {
            onBulkSetRepeat(Array.from(selectedIds), repeat);
            setShowMultiRepeat(false);
          }}
        />
      )}
    </div>
  );
}

// 여러 블록에 한꺼번에 적용할 반복 규칙을 정의하는 미니 모달.
// 기존 상세 패널 안 반복 UI 와 형태를 맞춰서 일관성 있게. 저장 시 각 블록에 대해
// bulkSetRepeatForBlocks 로 setBlockRepeat 을 호출 — 블록별 반복 그룹이 각각 만들어짐.
// 일/주 뷰 하단(또는 단독)에 뜨는 할 일 리스트 패널. 원형 체크박스 + 색 스트라이프 카드로 렌더하고,
// groupMode 에 따라 날짜별(기본) 또는 카테고리별 섹션으로 묶는다. 새 할 일 추가는 섹션 hover 시
// "+ 새 할 일" 고스트 — 날짜별은 카테고리 픽커를 거치고, 카테고리별은 그 카테고리로 즉시 생성.
function TodoPanel({
  todos, templates, todoChecklistItems, viewDays, paletteColors, groupMode, onChangeGroupMode,
  onAdd, onAddTemplate, onDelete, onUpdateTitle, onSelectTodo, onToggleTodo, onChangeCategory,
  deadlines, onToggleDeadline, onSelectDeadline,
  showDayHeader, onGoPrev, onGoNext, onMoveTodo, onSwapTodo,
}: {
  todos: Todo[];
  templates: Template[];
  todoChecklistItems: TodoChecklistItemT[];
  viewDays: Date[];
  paletteColors: string[];
  // 섹션 그룹 기준 — date: viewDays 의 각 날짜가 한 섹션, category: 카테고리가 한 섹션(기간 전체).
  groupMode: "date" | "category";
  // 리스트 우상단 드롭다운에서 그룹 기준 변경.
  onChangeGroupMode: (m: "date" | "category") => void;
  onAdd: (t: { title: string; date: string; endDate?: string | null; color?: string; category?: string }, options?: { openInline?: boolean }) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[]; kind?: "time" | "todo" }) => void;
  onDelete: (id: string) => void;
  onUpdateTitle: (id: string, title: string) => void;
  // 할 일 카드 클릭 → 상세 패널 열기. 없으면 기존 인라인 편집 fallback.
  onSelectTodo?: (t: Todo) => void;
  onToggleTodo: (id: string) => void;
  // 카테고리별 그룹에서 todo 를 다른 카테고리 섹션에 드랍하면 카테고리 변경.
  onChangeCategory?: (id: string, category: string) => void;
  // 할 일만 보는 모드(showDayHeader=true) 에서만 자체 마감 섹션을 그림. 시간 그리드가 함께 보일
  // 땐 그쪽 상단의 마감 행이 유일한 소스.
  deadlines: Deadline[];
  onToggleDeadline: (id: string) => void;
  onSelectDeadline?: (d: Deadline) => void;
  showDayHeader?: boolean;
  onGoPrev?: () => void;
  onGoNext?: () => void;
  // 드래그로 todo 를 다른 날짜 섹션으로 옮기기 위한 콜백. undefined 면 드래그 비활성.
  onMoveTodo?: (id: string, date: string) => void;
  // 두 todo 가 서로 자리를 교체할 때 호출. 위에 겹쳐 드랍하면 발화.
  onSwapTodo?: (aId: string, bId: string) => void;
}) {
  const [dragTodoId, setDragTodoId] = useState<string | null>(null);
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  // 드래그 중 마우스가 hover 중인 섹션 키(날짜별=dateStr, 카테고리별="cat:이름") — 드랍 프리뷰 강조용.
  const [tplHoverKey, setTplHoverKey] = useState<string | null>(null);
  // 사용자가 드래그를 섹션 밖에서 놓거나 Esc 로 취소한 경우 tplHoverKey 가 stuck 되지 않도록
  // 전역 dragend/drop 리스너로 안전망 클리어.
  useEffect(() => {
    const clear = () => setTplHoverKey(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  // 기존 할 일 카드의 인라인 제목 편집 상태 (더블클릭으로 진입).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  // 섹션 hover 상태 — hover 시 "+ 새 할 일" 프리뷰(shadow)를 노출.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // 그룹 기준(날짜별/카테고리별) 드롭다운 열림 여부 — 바깥 클릭·Esc 로 닫음.
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sortOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setSortOpen(false); };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortOpen]);
  // "+ 새 할 일" 클릭 시 열리는 추가 폼이 붙는 위치. 날짜 섹션이면 date 고정, 카테고리 섹션이면
  // category 고정, 하단 공통 버튼(__global__)이면 둘 다 자유. 날짜가 자유로우면 addDate 로 선택.
  const [addPicker, setAddPicker] = useState<null | { key: string; date?: string; category?: string }>(null);
  // 추가 폼의 날짜 선택값 — 폼을 열 때마다 오늘로 리셋.
  const [addDate, setAddDate] = useState<string>(TODAY_STR);
  // 카테고리 선택 UI 안에서 "새 카테고리" 인라인 폼이 열려있는지.
  const [newCatMode, setNewCatMode] = useState(false);
  const [newCatTitle, setNewCatTitle] = useState("");
  const [newCatColor, setNewCatColor] = useState<string>(paletteColors[0] ?? "#5AA9E6");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // 추가 폼 바깥 클릭 · Esc 로 닫기.
  useEffect(() => {
    if (!addPicker) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setAddPicker(null); setNewCatMode(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setAddPicker(null); setNewCatMode(false); }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addPicker]);
  // 카테고리 목록 — 사이드바와 동일 필터. kind='todo' 인 템플릿이 곧 카테고리.
  const categories = templates.filter(t => t.kind === "todo");
  // 카테고리 선택 → 그 카테고리로 새 할 일 만들고 상세 패널 오픈.
  const pickCategory = (dateStr: string, category: string) => {
    onAdd({ title: "새 할 일", date: dateStr, category }, { openInline: true });
    setAddPicker(null);
    setNewCatMode(false);
  };
  // 새 카테고리 생성 → 만든 카테고리로 곧바로 할 일 생성 진입.
  const commitNewCategory = (dateStr: string) => {
    const name = newCatTitle.trim();
    if (!name) return;
    // 이름 충돌 시 기존 카테고리 재사용 — 색은 기존 것을 유지.
    const existing = categories.find(c => c.title === name);
    if (!existing) {
      onAddTemplate({ title: name, color: newCatColor, tags: [], kind: "todo" });
    }
    setNewCatTitle(""); setNewCatMode(false);
    pickCategory(dateStr, name);
  };

  // 멀티데이(endDate) todo 는 걸치는 모든 날짜 섹션에 나타남.
  const coversDate = (t: Todo, ds: string) => t.date === ds || (!!t.endDate && ds >= t.date && ds <= t.endDate);
  const fmtDateShort = (ds: string) => {
    const d = parseLocalDate(ds);
    return `${d.getMonth() + 1}/${d.getDate()} (${DAYS_KO[d.getDay()]})`;
  };

  const viewDateStrs = viewDays.map(toDateStr);
  const firstDs = viewDateStrs[0];
  const lastDs = viewDateStrs[viewDateStrs.length - 1];
  // 마감 — 할 일 단독 모드에서만 카드로 노출 (시간 그리드가 함께 보일 땐 그쪽 상단 마감 행이 유일한 소스).
  const rangeDeadlines = showDayHeader
    ? deadlines.filter(d => viewDateStrs.includes(d.dueDate)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    : [];

  // 마감 카드 — 할 일 카드와 같은 블록 형태(원형 체크 + 스트라이프).
  // 블록 색(배경/스트라이프/체크 아이콘)은 마감 커스텀 색이 있으면 그것을, 없으면 D-day 톤.
  // D-day 배지는 항상 D-day 톤(>10 초록, 이하 노랑/주황/빨강)을 그대로 사용.
  const renderDeadlineCard = (d: Deadline) => {
    const daysLeft = daysBetween(parseLocalDate(d.dueDate), TODAY_DATE);
    const dayColor = deadlineToneHex(daysLeft);
    const blockColor = d.color || dayColor;
    return (
      <div
        key={d.id}
        onClick={() => onSelectDeadline?.(d)}
        className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer hover:shadow-sm transition-all ${d.completed ? "bg-card opacity-60" : ""}`}
        style={d.completed ? undefined : { backgroundColor: blockColor + "18", borderColor: blockColor + "55" }}
        title="클릭: 상세 열기"
      >
        <button
          onClick={e => { e.stopPropagation(); onToggleDeadline(d.id); }}
          className="flex-shrink-0"
          title={d.completed ? "완료 해제" : "완료 처리"}
        >
          {d.completed
            ? <CheckCircle2 size={18} style={{ color: blockColor }} />
            : <Circle size={18} className="text-muted-foreground" />}
        </button>
        <span className="w-0.5 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: blockColor }} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium truncate ${d.completed ? "line-through text-muted-foreground" : ""}`}>{d.title}</div>
          <div className="text-[11px] text-muted-foreground">{fmtDateShort(d.dueDate)}</div>
        </div>
        <span
          className="text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: dayColor + "22", color: dayColor }}
        >{formatDDay(daysLeft)}</span>
      </div>
    );
  };
  // 카테고리별 그룹 — 기간에 걸치는 todo 전체를 카테고리 섹션으로. 빈 카테고리도 섹션을 만들어
  // 드랍/추가 대상이 되게 하고, 미분류는 항상 마지막.
  const rangeTodos = todos.filter(t => t.date <= lastDs && (t.endDate ?? t.date) >= firstDs);
  const categorySections = (() => {
    const byCat = new Map<string, Todo[]>();
    for (const c of categories) byCat.set(c.title, []);
    byCat.set("", []);
    for (const t of rangeTodos) {
      const cat = (t.category ?? "").trim();
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(t);
    }
    return Array.from(byCat.entries())
      .map(([category, list]) => ({
        category,
        todos: [...list].sort((a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder),
      }))
      .sort((a, b) => (a.category === "" ? 1 : b.category === "" ? -1 : 0));
  })();

  // "+ 새 할 일" 고스트 — 시간 그리드의 hover ghost 와 톤/그림자를 맞춘 카드형 버튼.
  const ghostCardCls = "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left bg-primary/5 ring-1 ring-primary/25 hover:ring-primary/40 transition-shadow";
  const ghostShadow = { boxShadow: "0 6px 16px -6px rgba(90, 169, 230, 0.35), 0 2px 6px -2px rgba(90, 169, 230, 0.25)" };

  // 할 일 카드 — 스크린샷의 리스트 카드 디자인: 원형 체크박스 + 색 스트라이프 + 제목/부제.
  // 클릭 → 상세 패널, 더블클릭 → 인라인 제목 편집. 드래그로 이동/스왑.
  const renderTodoCard = (t: Todo, opts: { showDate?: boolean; showCategory?: boolean } = {}) => {
    const color = getCategoryColor(templates, t.category);
    const clItems = todoChecklistItems.filter(c => c.todoId === t.id);
    const clDone = clItems.filter(c => c.completed).length;
    const dateLabel = t.endDate && t.endDate !== t.date
      ? `${fmtDateShort(t.date)} – ${fmtDateShort(t.endDate)}`
      : opts.showDate ? fmtDateShort(t.date) : null;
    return (
      <div
        key={t.id}
        draggable={!!onMoveTodo && editingId !== t.id}
        onDragStart={e => {
          if (!onMoveTodo) return;
          e.dataTransfer.setData("todoId", t.id);
          e.dataTransfer.effectAllowed = "move";
          setDragTodoId(t.id);
        }}
        onDragEnd={() => { setDragTodoId(null); setSwapTargetId(null); }}
        onDragOver={e => {
          if (!onSwapTodo) return;
          if (!dragTodoId || dragTodoId === t.id) return;
          // 다른 todo 위 hover — 이 todo 위로 스왑 준비. 섹션의 drop 이 뜨지 않도록 stop.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setSwapTargetId(t.id);
        }}
        onDragLeave={() => { setSwapTargetId(prev => prev === t.id ? null : prev); }}
        onDrop={e => {
          if (!onSwapTodo) return;
          const otherId = e.dataTransfer.getData("todoId");
          if (!otherId || otherId === t.id) return;
          e.preventDefault();
          e.stopPropagation();
          onSwapTodo(otherId, t.id);
          setDragTodoId(null); setSwapTargetId(null);
        }}
        onClick={() => {
          if (onSelectTodo) onSelectTodo(t);
          else { setEditingDraft(t.title); setEditingId(t.id); }
        }}
        onDoubleClick={e => { e.stopPropagation(); setEditingDraft(t.title); setEditingId(t.id); }}
        className={`group/todo relative flex items-center gap-3 px-4 py-3 rounded-xl border bg-card transition-all ${
          onMoveTodo && editingId !== t.id ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
        } ${
          t.completed ? "opacity-60"
            : swapTargetId === t.id ? "ring-2 ring-primary ring-offset-1"
            : dragTodoId === t.id ? "opacity-50"
            : "hover:shadow-sm"
        }`}
        title="클릭: 상세 열기 · 더블클릭: 제목 편집"
      >
        {t.countInCompletion !== false ? (
          <button
            onClick={e => { e.stopPropagation(); onToggleTodo(t.id); }}
            className="flex-shrink-0"
            title={t.completed ? "완료 해제" : "완료 처리"}
          >
            {t.completed ? <CheckCircle2 size={18} style={{ color }} /> : <Circle size={18} className="text-muted-foreground" />}
          </button>
        ) : (
          /* 달성률 미포함 항목은 완료 개념이 없음 — 체크박스 자리만 유지해 카드 정렬을 맞춤. */
          <span className="w-[18px] flex-shrink-0" />
        )}
        <span className="w-0.5 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <div className="flex-1 min-w-0">
          {editingId === t.id ? (
            <input
              autoFocus
              value={editingDraft}
              onChange={e => setEditingDraft(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={() => { onUpdateTitle(t.id, editingDraft.trim() || t.title); setEditingId(null); }}
              onKeyDown={e => {
                if (e.key === "Enter") { onUpdateTitle(t.id, editingDraft.trim() || t.title); setEditingId(null); }
                else if (e.key === "Escape") setEditingId(null);
              }}
              className="w-full text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 -mx-1"
            />
          ) : (
            <div className="flex items-baseline gap-1.5 min-w-0">
              {t.repeatGroupId && <span title="반복 할 일" className="text-xs text-muted-foreground flex-shrink-0">↻</span>}
              <span className={`min-w-0 truncate text-sm font-medium ${t.completed ? "line-through text-muted-foreground" : ""}`}>{t.title}</span>
              {opts.showCategory && t.category && (
                <span
                  className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm flex-shrink-0"
                  style={{ color, backgroundColor: color + "22" }}
                >{t.category}</span>
              )}
            </div>
          )}
          {editingId !== t.id && (dateLabel || t.memo || clItems.length > 0) && (
            <div className="flex items-center gap-2 min-w-0 text-[11px] text-muted-foreground">
              {dateLabel && <span className="flex-shrink-0">{dateLabel}</span>}
              {t.memo && <span className="truncate">{t.memo}</span>}
              {clItems.length > 0 && (
                <span className="inline-flex items-center gap-0.5 flex-shrink-0" style={{ color }}>
                  {clDone === clItems.length ? <CheckCircle2 size={10} /> : <Square size={10} />}
                  <span>{clDone}/{clItems.length}</span>
                </span>
              )}
            </div>
          )}
        </div>
        {/* 우측 상단 hover 액션 — 삭제(X). */}
        <button
          onClick={e => { e.stopPropagation(); onDelete(t.id); }}
          className="absolute top-1.5 right-1.5 size-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-muted opacity-0 group-hover/todo:opacity-100 transition-opacity"
          title="삭제"
        ><X size={12} /></button>
      </div>
    );
  };

  // "+ 새 할 일" 클릭 시 열리는 추가 폼. 날짜가 자유로우면(전역/카테고리 섹션) 날짜 입력을 먼저
  // 보여주고(기본 오늘), 카테고리가 자유로우면 카테고리 목록을, 고정이면 추가 버튼만 보여준다.
  const renderAddPicker = () => {
    if (!addPicker) return null;
    const effDate = addPicker.date ?? addDate;
    return (
      <div
        ref={pickerRef}
        className="rounded-xl bg-card border border-primary/25 shadow-lg p-1 space-y-0.5"
        style={ghostShadow}
      >
        {addPicker.date == null && (
          <div className="px-1.5 py-0.5 space-y-0.5">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">날짜</div>
            <input
              type="date"
              value={addDate}
              onChange={e => { if (e.target.value) setAddDate(e.target.value); }}
              className="w-full text-[11px] px-1.5 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}
        {addPicker.category !== undefined ? (
          /* 카테고리 고정(카테고리 섹션) — 날짜만 고르고 바로 추가. */
          <button
            onClick={() => pickCategory(effDate, addPicker.category!)}
            className="w-full text-[11px] py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >추가</button>
        ) : (
          <>
            <div className="text-[9px] text-muted-foreground px-1.5 py-0.5 uppercase tracking-wide">카테고리 선택</div>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => pickCategory(effDate, c.title)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted text-left"
              >
                <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: c.color }} />
                <span className="text-[10px] truncate">{c.title}</span>
              </button>
            ))}
            {categories.length === 0 && (
              <div className="text-[9px] text-muted-foreground px-1.5 py-1">아직 카테고리가 없습니다</div>
            )}
            <button
              onClick={() => pickCategory(effDate, "")}
              className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted text-left"
            >
              <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: UNCATEGORIZED_TODO_COLOR }} />
              <span className="text-[10px] text-muted-foreground truncate">미분류</span>
            </button>
            <div className="h-px bg-border/60 my-0.5" />
            {newCatMode ? (
              <div className="p-1 space-y-1">
                <input
                  autoFocus
                  value={newCatTitle}
                  onChange={e => setNewCatTitle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); commitNewCategory(effDate); }
                    else if (e.key === "Escape") { e.preventDefault(); setNewCatMode(false); setNewCatTitle(""); }
                  }}
                  placeholder="카테고리 이름..."
                  className="w-full text-[10px] px-1.5 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                />
                <div className="flex flex-wrap gap-1">
                  {paletteColors.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewCatColor(c)}
                      className={`size-4 rounded-full transition-transform ${newCatColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => commitNewCategory(effDate)}
                    disabled={!newCatTitle.trim()}
                    className="flex-1 text-[10px] py-1 rounded bg-primary text-primary-foreground disabled:opacity-40"
                  >추가</button>
                  <button
                    onClick={() => { setNewCatMode(false); setNewCatTitle(""); }}
                    className="flex-1 text-[10px] py-1 rounded bg-muted hover:bg-muted/70"
                  >취소</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setNewCatMode(true)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted text-left"
              >
                <Plus size={10} className="text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground truncate">새 카테고리</span>
              </button>
            )}
          </>
        )}
      </div>
    );
  };
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {showDayHeader && (
        /* 요일/날짜 헤더 — 시간표 뷰의 요일 헤더와 동일한 톤. 좌/우 끝 chevron 으로 기간 이동. */
        <div className="relative flex border-b border-border flex-shrink-0 bg-card items-stretch overflow-hidden">
          {onGoPrev ? (
            <button
              onClick={onGoPrev}
              className="w-12 flex-shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
              title="이전"
            ><ChevronLeft size={16} /></button>
          ) : <div className="w-12 flex-shrink-0" />}
          {viewDays.map((day, i) => {
            const ds = toDateStr(day);
            const isToday = ds === TODAY_STR;
            const dow = day.getDay();
            const holiday = getHoliday(ds);
            return (
              <div key={i} className="flex-1 text-center py-2 min-w-0" title={holiday ?? undefined}>
                <div className={`text-[10px] ${holiday || (viewDays.length > 1 && dow === 0) ? "text-red-400" : viewDays.length > 1 && dow === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                  {DAYS_KO[dow]}
                </div>
                <div className={`inline-flex items-center justify-center w-7 h-7 mt-0.5 rounded-full text-xs font-medium ${isToday ? "bg-primary text-primary-foreground" : holiday ? "text-red-400" : "text-foreground"}`}>
                  {day.getDate()}
                </div>
              </div>
            );
          })}
          {onGoNext && (
            <button
              onClick={onGoNext}
              className="absolute right-0 top-0 bottom-0 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors rounded-l"
              title="다음"
            ><ChevronRight size={16} /></button>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg w-full mx-auto">
          {/* 그룹 기준 드롭다운 — 리스트 우상단. 버튼 오른쪽 끝을 카드 컬럼 오른쪽 끝에 맞춤.
               ⚠ translate 로 옮기면 새 stacking context 가 생겨 아래 카드가 드롭다운을 가림 —
               위치 조정은 transform 대신 flex 로만.
               ⚠ 부모에 space-y-6 를 두면 버튼 아래 24px 갭이 강제로 붙어 버튼이 붕 떠 보임 —
               space-y-6 는 실제 섹션 목록에만 걸고, 버튼-섹션 사이 간격은 mb-2 로 좁게. */}
          <div className="flex justify-end mb-2">
            <div className="relative" ref={sortRef}>
              <button
                onClick={() => setSortOpen(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border bg-card hover:bg-muted transition-colors"
                title="그룹 기준 변경"
              >
                <ArrowUpDown size={12} className="text-muted-foreground" />
                {groupMode === "date" ? "날짜별" : "카테고리별"}
              </button>
              {sortOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 w-32 rounded-lg border border-border bg-card shadow-lg p-1 space-y-0.5">
                  {([["date", "날짜별"], ["category", "카테고리별"]] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => { onChangeGroupMode(v); setSortOpen(false); }}
                      className={`w-full text-left px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                        groupMode === v ? "text-primary font-medium bg-primary/5" : "hover:bg-muted"
                      }`}
                    >{label}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-6">
          {groupMode === "date" ? <>
          {/* 빈 날짜 섹션은 숨김 — 할 일이나 마감이 있는 날만 날짜 헤더 + 카드 노출. */}
          {viewDays.filter(d => {
            const ds = toDateStr(d);
            return todos.some(t => coversDate(t, ds)) || rangeDeadlines.some(dl => dl.dueDate === ds);
          }).map((day) => {
            const dateStr = toDateStr(day);
            const isToday = dateStr === TODAY_STR;
            const dow = day.getDay();
            const dayTodos = sortTodosByCategory(todos.filter(t => coversDate(t, dateStr)));
            return (
              <div
                key={dateStr}
                onMouseEnter={() => setHoverKey(dateStr)}
                onMouseLeave={() => setHoverKey(prev => prev === dateStr ? null : prev)}
                onDragOver={e => {
                  // 카테고리(todoTemplateId/todoCategory) 나 기존 todo(todoId) 를 이 섹션에 놓을 수 있게 허용.
                  // ⚠ Chromium 의 dataTransfer.types 는 소문자로 정규화됨 → 반드시 소문자 비교.
                  const types = e.dataTransfer.types;
                  const isCat = types.includes("todotemplateid") || types.includes("todocategory");
                  const isTodo = types.includes("todoid");
                  if (isCat || isTodo) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = isTodo ? "move" : "copy";
                    if (isCat) setTplHoverKey(dateStr);
                  }
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setTplHoverKey(prev => prev === dateStr ? null : prev);
                  }
                }}
                onDrop={e => {
                  setTplHoverKey(null);
                  // 카테고리 드래그 → 빈 제목의 새 할 일 + 상세 패널 자동 오픈(제목 편집 상태).
                  // 색은 렌더링 시 카테고리에서 자동 조회되므로 여기서 전달하지 않음.
                  const category = e.dataTransfer.getData("todoCategory");
                  if (category) {
                    e.preventDefault();
                    onAdd({ title: "새 할 일", date: dateStr, category }, { openInline: true });
                    return;
                  }
                  // 기존 todo 를 이 섹션(빈 영역) 에 드랍하면 date 만 이 날짜로 옮김.
                  // 특정 todo 위에 드랍하면 카드의 onDrop 이 먼저 처리하며 stopPropagation.
                  const todoId = e.dataTransfer.getData("todoId");
                  if (todoId && onMoveTodo) {
                    e.preventDefault();
                    onMoveTodo(todoId, dateStr);
                  }
                }}
                className={`rounded-xl transition-colors ${tplHoverKey === dateStr ? "bg-primary/5" : ""}`}
              >
                {/* 섹션 헤더 — 날짜 + (오늘) 배지 + 라인 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-[11px] font-semibold tracking-wide ${isToday ? "text-primary" : isHoliday(dateStr) || dow === 0 ? "text-red-400" : dow === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                    {day.getMonth() + 1}월 {day.getDate()}일 ({DAYS_KO[dow]})
                  </span>
                  {getHoliday(dateStr) && (
                    <span className="text-[10px] font-medium text-red-400">{getHoliday(dateStr)}</span>
                  )}
                  {isToday && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">오늘</span>}
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                <div className="space-y-2">
                  {/* 마감 — 해당 날짜 섹션의 가장 상단에 카드로 노출. */}
                  {rangeDeadlines.filter(dl => dl.dueDate === dateStr).map(renderDeadlineCard)}
                  {dayTodos.map(t => renderTodoCard(t, { showCategory: true }))}
                  {/* 카테고리 드래그 hover 시 드랍 위치 프리뷰 */}
                  {tplHoverKey === dateStr && (
                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5 text-xs text-primary">
                      <Plus size={12} /> 여기에 새 할 일 추가
                    </div>
                  )}
                  {/* "+ 새 할 일" — hover 고스트 클릭 → 카테고리 픽커(날짜는 이 섹션으로 고정). */}
                  {addPicker?.key === dateStr ? renderAddPicker()
                    : hoverKey === dateStr && tplHoverKey !== dateStr ? (
                      <button
                        onClick={() => { setAddPicker({ key: dateStr, date: dateStr }); setNewCatMode(false); }}
                        className={ghostCardCls}
                        style={ghostShadow}
                        title="새 할 일 추가"
                      >
                        <span className="text-xs text-primary/70 font-medium">+ 새 할 일</span>
                      </button>
                    ) : null}
                </div>
              </div>
            );
          })}
          {viewDays.every(d => !todos.some(t => coversDate(t, toDateStr(d)))) && rangeDeadlines.length === 0 && (
            <p className="text-sm text-muted-foreground pt-2 text-center">이 기간에 등록된 할 일이 없습니다</p>
          )}
          {/* 빈 날짜 섹션이 없으므로 새 할 일 진입점은 하단 공통 버튼 — 날짜(기본 오늘)와
               카테고리를 폼에서 선택해 추가. */}
          {addPicker?.key === "__global__" ? renderAddPicker() : (
            <button
              onClick={() => { setAddDate(TODAY_STR); setAddPicker({ key: "__global__" }); setNewCatMode(false); }}
              className={ghostCardCls}
              style={ghostShadow}
              title="새 할 일 추가"
            >
              <span className="text-xs text-primary/70 font-medium">+ 새 할 일</span>
            </button>
          )}
          </> : <>
          {/* 마감 — 카테고리별 그룹에선 항상 리스트 최상단 섹션에 카드로 노출. */}
          {rangeDeadlines.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">마감</span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <div className="space-y-2">
                {rangeDeadlines.map(renderDeadlineCard)}
              </div>
            </div>
          )}
          {categorySections.map(sec => {
            const color = sec.category ? getCategoryColor(templates, sec.category) : UNCATEGORIZED_TODO_COLOR;
            const key = `cat:${sec.category || "__none__"}`;
            return (
              <div
                key={key}
                onMouseEnter={() => setHoverKey(key)}
                onMouseLeave={() => setHoverKey(prev => prev === key ? null : prev)}
                onDragOver={e => {
                  // todo 드래그 → 이 카테고리 섹션에 드랍하면 카테고리 변경.
                  if (!onChangeCategory) return;
                  if (e.dataTransfer.types.includes("todoid")) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setTplHoverKey(key);
                  }
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setTplHoverKey(prev => prev === key ? null : prev);
                  }
                }}
                onDrop={e => {
                  setTplHoverKey(null);
                  const todoId = e.dataTransfer.getData("todoId");
                  if (todoId && onChangeCategory) {
                    e.preventDefault();
                    onChangeCategory(todoId, sec.category);
                  }
                }}
                className={`rounded-xl transition-colors ${tplHoverKey === key ? "bg-primary/5" : ""}`}
              >
                {/* 섹션 헤더 — 카테고리 색 점 + 이름 + 라인 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-[11px] font-semibold tracking-wide text-muted-foreground truncate">{sec.category || "미분류"}</span>
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                <div className="space-y-2">
                  {sec.todos.map(t => renderTodoCard(t, { showDate: true }))}
                  {sec.todos.length === 0 && hoverKey !== key && tplHoverKey !== key && (
                    <div className="text-[11px] text-muted-foreground/50 px-1">항목 없음</div>
                  )}
                  {/* todo 드래그 hover 시 — 이 카테고리로 변경 프리뷰 */}
                  {tplHoverKey === key && (
                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5 text-xs text-primary">
                      <Plus size={12} /> 이 카테고리로 이동
                    </div>
                  )}
                  {/* "+ 새 할 일" — 카테고리는 섹션 것으로 고정, 날짜(기본 오늘)만 폼에서 선택. */}
                  {addPicker?.key === key ? renderAddPicker()
                    : hoverKey === key && tplHoverKey !== key ? (
                      <button
                        onClick={() => { setAddDate(TODAY_STR); setAddPicker({ key, category: sec.category }); setNewCatMode(false); }}
                        className={ghostCardCls}
                        style={ghostShadow}
                        title="새 할 일 추가"
                      >
                        <span className="text-xs text-primary/70 font-medium">+ 새 할 일</span>
                      </button>
                    ) : null}
                </div>
              </div>
            );
          })}
          </>}
          </div>
        </div>
      </div>
    </div>
  );
}

// 반복 블록/할 일 삭제 시 범위(단건/이후 전체) 를 물어보는 확인 모달. 스타일은 MultiRepeatModal 과 통일.
// noun 은 "블록" | "할 일" — 블록/할 일 양쪽에서 재사용하기 위해 문구만 파라미터화.
function RepeatDeleteModal({
  title, noun = "블록", onClose, onDeleteOne, onDeleteFollowing,
}: {
  title: string;
  noun?: string;
  onClose: () => void;
  onDeleteOne: () => void;
  onDeleteFollowing: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-80 bg-card border border-border rounded-xl p-4 shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold mb-1">반복 {noun} 삭제</div>
        <div className="text-[11px] text-muted-foreground mb-4 truncate">"{title || "제목 없음"}"</div>
        <div className="space-y-2">
          <button
            onClick={onDeleteOne}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-border text-xs hover:bg-muted transition-colors"
          >
            <div className="font-medium">이 {noun}만 삭제</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">나머지 반복 일정은 그대로 유지</div>
          </button>
          <button
            onClick={onDeleteFollowing}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-destructive/40 text-xs hover:bg-destructive/10 text-destructive transition-colors"
          >
            <div className="font-medium">이후 모든 {noun} 삭제</div>
            <div className="text-[10px] text-destructive/70 mt-0.5">오늘 이후의 반복 인스턴스가 함께 사라집니다</div>
          </button>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted transition-colors">취소</button>
        </div>
      </div>
    </div>
  );
}

function MultiRepeatModal({
  count, onClose, onApply,
}: {
  count: number;
  onClose: () => void;
  onApply: (repeat: BlockRepeat) => void;
}) {
  const [type, setType] = useState<"daily" | "weekly" | "monthly" | "yearly">("daily");
  const [days, setDays] = useState<number[]>([]);
  const [endType, setEndType] = useState<"none" | "count" | "date">("none");
  const [endCount, setEndCount] = useState(10);
  const [endDate, setEndDate] = useState("");
  const DAYS_LABEL = ["일", "월", "화", "수", "목", "금", "토"];
  const toggleDay = (d: number) => setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort());
  const canApply = type !== "weekly" || days.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-80 bg-card border border-border rounded-xl p-4 shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold mb-1">반복 설정</div>
        <div className="text-[11px] text-muted-foreground mb-4">{count}개 블록에 같은 규칙이 적용돼요</div>

        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-muted-foreground mb-1.5">반복 주기</div>
            <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5">
              {([["daily", "매일"], ["weekly", "매주"], ["monthly", "매달"], ["yearly", "매년"]] as const).map(([v, label]) => (
                <button key={v} onClick={() => setType(v)}
                  className={`flex-1 px-1 py-1.5 text-[11px] rounded-md transition-all ${type === v ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {type === "weekly" && (
            <div>
              <div className="text-[11px] text-muted-foreground mb-1.5">요일</div>
              <div className="flex gap-1">
                {DAYS_LABEL.map((label, i) => (
                  <button key={i} onClick={() => toggleDay(i)}
                    className={`flex-1 py-1.5 text-[11px] rounded-md border transition-colors ${days.includes(i) ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] text-muted-foreground mb-1.5">종료</div>
            <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5 mb-2">
              {([{ v: "none", label: "제한 없음" }, { v: "count", label: "N회" }, { v: "date", label: "날짜까지" }] as const).map(o => (
                <button key={o.v} onClick={() => setEndType(o.v)}
                  className={`flex-1 px-2 py-1.5 text-[11px] rounded-md transition-all ${endType === o.v ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {endType === "count" && (
              <input type="number" min={1} value={endCount} onChange={e => setEndCount(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring" />
            )}
            {endType === "date" && (
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring" />
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted transition-colors">취소</button>
          <button
            onClick={() => onApply({ type, days, endType, endCount, endDate })}
            disabled={!canApply || (endType === "date" && !endDate)}
            className="flex-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >적용</button>
        </div>
      </div>
    </div>
  );
}

// ── Deadlines Section ──────────────────────────────────────────────
function DeadlinesSection({
  deadlines, onToggle, onAddDeadline, onDelete, onUpdateDeadline,
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
}: {
  deadlines: Deadline[];
  onToggle: (id: string) => void;
  onAddDeadline: (d: { title: string; dueDate: string }) => void;
  onDelete: (id: string) => void;
  onUpdateDeadline: (id: string, changes: { title?: string; dueDate?: string; color?: string }) => void;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
}) {
  const active = deadlines.filter(d => !d.completed);
  const overdue = active.filter(d => d.dueDate < TODAY_STR);
  const upcoming = active.filter(d => d.dueDate >= TODAY_STR);
  const completed = deadlines.filter(d => d.completed);

  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueDate, setNewDueDate] = useState(TODAY_STR);

  // 칸반 보드로 열어둔 마감 작업 id. 목록에서 행을 클릭하면 진입, 뒤로가기로 복귀.
  // deadlines prop 에서 매 렌더 재조회 — 보드를 보는 중 마감이 삭제되면 자동으로 목록 복귀.
  const [boardId, setBoardId] = useState<string | null>(null);
  const boardDeadline = boardId ? deadlines.find(d => d.id === boardId) : undefined;

  const daysLeft = (date: string) => daysBetween(parseLocalDate(date), TODAY_DATE);

  if (boardDeadline) {
    return (
      <KanbanBoard
        deadline={boardDeadline} onBack={() => setBoardId(null)}
        onUpdateDeadline={onUpdateDeadline}
        paletteColors={paletteColors} onAddPaletteColor={onAddPaletteColor} onRemovePaletteColor={onRemovePaletteColor}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 pt-16 pb-8">
        {overdue.length > 0 && (
          <div className="mb-7">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">지난 마감</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{overdue.length}</span>
            </div>
            <div className="space-y-2">
              {overdue.map(d => {
                const dl = daysLeft(d.dueDate);
                // 블록 색은 커스텀 우선, D-day 배지는 항상 D-day 톤.
                const dayColor = deadlineToneHex(dl);
                const blockColor = d.color || dayColor;
                return (
                  <div
                    key={d.id}
                    onClick={() => setBoardId(d.id)}
                    className="group/dl flex items-center gap-4 px-4 py-3.5 rounded-xl border cursor-pointer hover:brightness-[0.97] transition-all"
                    style={{ backgroundColor: blockColor + "18", borderColor: blockColor + "55" }}
                  >
                    <button onClick={e => { e.stopPropagation(); onToggle(d.id); }}><Circle size={18} style={{ color: blockColor }} /></button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{d.title}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{d.dueDate}</div>
                    </div>
                    <span
                      className="text-[11px] px-2.5 py-1 rounded-full font-medium flex-shrink-0"
                      style={{ backgroundColor: dayColor + "22", color: dayColor }}
                    >
                      {formatDDay(dl)}
                    </span>
                    <button
                      onClick={e => { e.stopPropagation(); onDelete(d.id); }}
                      title="삭제"
                      className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                    ><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mb-7">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">진행 중</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{upcoming.length}</span>
          </div>
          <div className="space-y-2">
            {upcoming.map(d => {
              const dl = daysLeft(d.dueDate);
              // 블록 색은 커스텀 우선, D-day 배지는 항상 D-day 톤.
              const dayColor = deadlineToneHex(dl);
              const blockColor = d.color || dayColor;
              return (
                <div
                  key={d.id}
                  onClick={() => setBoardId(d.id)}
                  className="group/dl flex items-center gap-4 px-4 py-3.5 rounded-xl border cursor-pointer hover:brightness-[0.97] transition-all"
                  style={{ backgroundColor: blockColor + "18", borderColor: blockColor + "55" }}
                >
                  <button onClick={e => { e.stopPropagation(); onToggle(d.id); }}><Circle size={18} style={{ color: blockColor }} /></button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{d.dueDate}</div>
                  </div>
                  <span
                    className="text-[11px] px-2.5 py-1 rounded-full font-medium flex-shrink-0"
                    style={{ backgroundColor: dayColor + "22", color: dayColor }}
                  >
                    {formatDDay(dl)}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(d.id); }}
                    title="삭제"
                    className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><Trash2 size={14} /></button>
                </div>
              );
            })}
            {showAdd ? (
              <div className="p-3 rounded-xl border bg-card space-y-2">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="제목..."
                  className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                />
                <input
                  type="date"
                  value={newDueDate}
                  onChange={e => setNewDueDate(e.target.value)}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (!newTitle.trim()) return;
                      // 날짜 입력을 지운 채 추가하면 dueDate=""가 저장돼 문자열 비교에서
                      // 무조건 "지난 마감"으로 잡히는 이상 상태가 됨 — 오늘로 폴백.
                      const due = newDueDate || TODAY_STR;
                      onAddDeadline({ title: newTitle.trim(), dueDate: due });
                      setNewTitle(""); setShowAdd(false);
                    }}
                    disabled={!newTitle.trim() || !newDueDate}
                    className="flex-1 text-sm py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                  >
                    추가
                  </button>
                  <button onClick={() => setShowAdd(false)} className="flex-1 text-sm py-2 rounded-lg bg-muted hover:bg-muted/70 transition-colors">
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 mt-2 px-4 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-xl hover:bg-muted w-full"
              >
                <Plus size={15} /> 마감 작업 추가
              </button>
            )}
          </div>
        </div>

        {completed.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">완료됨</div>
            <div className="space-y-2 opacity-50">
              {completed.map(d => (
                <div key={d.id} onClick={() => setBoardId(d.id)} className="group/dl flex items-center gap-4 px-4 py-3 rounded-xl border cursor-pointer hover:bg-muted/50 transition-colors">
                  <button onClick={e => { e.stopPropagation(); onToggle(d.id); }}><CheckCircle2 size={18} className="text-sky-600" /></button>
                  <div className="flex-1 min-w-0 text-sm line-through text-muted-foreground">{d.title}</div>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(d.id); }}
                    title="삭제"
                    className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Kanban Board (마감 작업 상세 — 세부 작업 보드) ──────────────────
// 마감 작업 목록에서 행을 클릭하면 진입. 할 작업/진행 중/끝난 작업 3개 컬럼에
// 제목+내용으로 된 카드를 추가하고, 드래그로 컬럼 간 이동. 카드 디자인은 캘린더
// 시간 블록과 동일한 문법(색 tint 배경 + 좌측 3px 스트라이프, 색 글자).
const KANBAN_COLUMNS: { status: KanbanStatus; label: string }[] = [
  { status: "todo", label: "할 작업" },
  { status: "doing", label: "진행 중인 작업" },
  { status: "done", label: "끝난 작업" },
];

function KanbanBoard({
  deadline, onBack, onUpdateDeadline, paletteColors, onAddPaletteColor, onRemovePaletteColor,
}: {
  deadline: Deadline;
  onBack: () => void;
  onUpdateDeadline: (id: string, changes: { title?: string; dueDate?: string; color?: string }) => void;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
}) {
  // 헤더 제목 인라인 편집 — 다른 상세 패널과 같은 UX.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(deadline.title);
  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== deadline.title) onUpdateDeadline(deadline.id, { title: trimmed });
    else setTitleDraft(deadline.title);
    setEditingTitle(false);
  };
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  // 카드 추가 폼이 열려 있는 컬럼(한 번에 하나만).
  const [addingCol, setAddingCol] = useState<KanbanStatus | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  // 새 카드 색상 — 편집 폼과 동일하게 빈 문자열이면 마감 D-day 톤을 따라감.
  const [newColor, setNewColor] = useState("");
  const [showNewCustomColor, setShowNewCustomColor] = useState(false);
  // 카드 생성 전 체크리스트 임시 버퍼 — 카드가 없어서 DB에 못 쓰므로 로컬에만 보관하다
  // 추가 시점에 실제 카드 id 를 받아 순서대로 저장. parentItemId 는 임시 id 를 참조.
  const [newChecklist, setNewChecklist] = useState<ChecklistNodeItem[]>([]);
  // 드래그 중 카드가 올라가 있는 컬럼 — 하이라이트용.
  const [dragOverCol, setDragOverCol] = useState<KanbanStatus | null>(null);
  // 드래그 중인 카드 id — 원본 카드를 반투명 처리.
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  // 클릭으로 편집 중인 카드 — 카드 자리에 인라인 편집 폼을 렌더.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  // 편집 중 색상 — 빈 문자열이면 마감 D-day 톤을 따라가는 기본값.
  const [editColor, setEditColor] = useState("");
  // 편집 폼의 커스텀 색상 입력(hex) 열림 여부.
  const [showCustomColor, setShowCustomColor] = useState(false);
  // 이 마감의 모든 카드 체크리스트 — 카드 위 미리보기와 편집 폼이 공유.
  const [checkItems, setCheckItems] = useState<KanbanChecklistItem[]>([]);

  const dl = daysBetween(parseLocalDate(deadline.dueDate), TODAY_DATE);
  // D-day 톤 색 — 배지에는 항상 이 색을 사용해 "얼마나 남았는지"를 색으로도 즉시 읽히게.
  const color = deadlineToneHex(dl);
  // 스트라이프/카드 기본 색은 마감이 커스텀 색을 가진 경우 그것을, 없으면 D-day 톤을 사용.
  const stripeColor = deadline.color || color;
  // 팔레트 팝오버 열림 여부 + 커스텀 hex 입력 열림 여부.
  const [showPalette, setShowPalette] = useState(false);
  const [showDeadlineCustomColor, setShowDeadlineCustomColor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchKanbanCards(deadline.id), fetchKanbanChecklistItemsByDeadline(deadline.id)])
      .then(([cs, items]) => { if (!cancelled) { setCards(cs); setCheckItems(items); } })
      .catch(notifyError("칸반 보드 불러오기 실패"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deadline.id]);

  const addCard = async (status: KanbanStatus) => {
    const title = newTitle.trim();
    if (!title) return;
    const content = newContent.trim();
    const color = newColor;
    // 체크리스트 버퍼 스냅샷 — 폼 리셋 뒤 참조하기 위해 미리 캡처.
    const bufferedItems = newChecklist;
    // 추가 후 폼을 닫음 — 열어두면 방금 추가한 카드 아래에 빈 폼이 다시 떠서
    // "작업 추가 탭이 또 열리는" 것처럼 보임. 연속 추가는 버튼을 다시 누르는 쪽이 명확.
    setNewTitle(""); setNewContent(""); setNewColor(""); setShowNewCustomColor(false); setNewChecklist([]); setAddingCol(null);
    try {
      const c = await createKanbanCard({ deadlineId: deadline.id, status, title, content, color });
      setCards(cs => [...cs, c]);
      // 임시 id → 실제 id 매핑을 유지하며 DFS 순서로 저장 — 부모가 먼저 만들어져야
      // 하위 항목이 올바른 parent_item_id 로 저장됨.
      if (bufferedItems.length > 0) {
        const tempToReal = new Map<string, string>();
        const flat: ChecklistNodeItem[] = [];
        const walk = (parentTempId?: string) => {
          for (const it of bufferedItems.filter(i => i.parentItemId === parentTempId)) {
            flat.push(it);
            walk(it.id);
          }
        };
        walk(undefined);
        for (const it of flat) {
          const parentRealId = it.parentItemId ? tempToReal.get(it.parentItemId) : undefined;
          try {
            const created = await createKanbanChecklistItem(c.id, it.text, parentRealId);
            tempToReal.set(it.id, created.id);
            const finalItem = it.completed ? { ...created, completed: true } : created;
            setCheckItems(is => [...is, finalItem]);
            if (it.completed) {
              toggleKanbanChecklistItemRow(created.id, true).catch(notifyError("체크리스트 저장 실패"));
            }
          } catch (e) { notifyError("체크리스트 항목 추가 실패")(e); }
        }
      }
    } catch (e) { notifyError("작업 추가 실패")(e); }
  };

  // ── 새 카드용 체크리스트 로컬 조작 — 카드가 아직 없으므로 DB 대신 임시 버퍼만 갱신 ──
  const addNewCheckItem = (text: string, parentItemId?: string) => {
    const id = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setNewChecklist(is => [...is, { id, parentItemId, text, completed: false }]);
  };
  const toggleNewCheckItem = (id: string, completed: boolean) => {
    setNewChecklist(is => is.map(i => i.id === id ? { ...i, completed } : i));
  };
  const deleteNewCheckItem = (id: string) => {
    setNewChecklist(is => {
      const toRemove = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const it of is) {
          if (it.parentItemId && toRemove.has(it.parentItemId) && !toRemove.has(it.id)) {
            toRemove.add(it.id); grew = true;
          }
        }
      }
      return is.filter(i => !toRemove.has(i.id));
    });
  };

  // 컬럼 빈 공간으로 드롭 — 대상 컬럼 맨 아래로. 같은 컬럼이어도 "맨 아래로 이동"으로
  // 동작(이전엔 같은 컬럼 드롭이 무시됐음). 이미 맨 아래에 있으면 아무것도 안 함.
  const moveCard = (id: string, status: KanbanStatus) => {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    const rest = cards.filter(c => c.status === status && c.id !== id).sort((a, b) => a.sortOrder - b.sortOrder);
    if (card.status === status && (rest.length === 0 || rest[rest.length - 1].sortOrder < card.sortOrder)) return;
    const updates = [...rest, card].map((c, i) => ({ id: c.id, status, sortOrder: i }));
    setCards(cs => cs.map(c => {
      const u = updates.find(x => x.id === c.id);
      return u ? { ...c, status: u.status, sortOrder: u.sortOrder } : c;
    }));
    bulkUpdateKanbanCardOrder(updates).catch(notifyError("작업 이동 실패"));
  };

  // 카드 위에 드롭 — 그 카드의 앞/뒤(마우스가 카드 상반부면 앞)에 끼워 넣음.
  // 같은 컬럼 재정렬과 다른 컬럼으로의 위치 지정 이동을 모두 처리. 대상 컬럼 전체의
  // sort_order 를 0..n 으로 다시 매겨 한 번에 저장(부분 반영 방지는 bulk 함수가 담당).
  const reorderCard = (dragId: string, targetId: string, before: boolean) => {
    if (dragId === targetId) return;
    const drag = cards.find(c => c.id === dragId);
    const target = cards.find(c => c.id === targetId);
    if (!drag || !target) return;
    const col = target.status;
    const list = cards.filter(c => c.status === col && c.id !== dragId).sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = list.findIndex(c => c.id === targetId);
    if (idx < 0) return;
    list.splice(before ? idx : idx + 1, 0, drag);
    const updates = list.map((c, i) => ({ id: c.id, status: col, sortOrder: i }));
    setCards(cs => cs.map(c => {
      const u = updates.find(x => x.id === c.id);
      return u ? { ...c, status: u.status, sortOrder: u.sortOrder } : c;
    }));
    bulkUpdateKanbanCardOrder(updates).catch(notifyError("작업 순서 저장 실패"));
  };

  const deleteCard = (id: string) => {
    if (editingId === id) setEditingId(null);
    setCards(cs => cs.filter(c => c.id !== id));
    // DB 는 ON DELETE CASCADE 로 체크리스트도 함께 지워짐 — 로컬 상태도 정리.
    setCheckItems(is => is.filter(i => i.cardId !== id));
    deleteKanbanCardRow(id).catch(notifyError("작업 삭제 실패"));
  };

  // 편집 폼의 현재 입력값을 해당 카드에 저장. 제목이 비어 있으면 저장하지 않음(폐기).
  // 편집 상태(editingId 등)는 건드리지 않아 저장 후 닫기/다른 카드로 전환 양쪽에서 재사용.
  const commitEdit = (id: string) => {
    const title = editTitle.trim();
    if (!title) return;
    const changes = { title, content: editContent.trim(), color: editColor };
    setCards(cs => cs.map(c => c.id === id ? { ...c, ...changes } : c));
    updateKanbanCard(id, changes).catch(notifyError("작업 수정 실패"));
  };

  const startEdit = (card: KanbanCard) => {
    // 다른 카드를 편집하던 중이면 그 변경분을 조용히 잃지 않도록 먼저 저장하고 전환.
    if (editingId && editingId !== card.id) commitEdit(editingId);
    setEditingId(card.id);
    setEditTitle(card.title);
    setEditContent(card.content);
    setEditColor(card.color);
    setShowCustomColor(false);
  };

  // ── 체크리스트 — BlockDetailPanel 과 동일한 낙관적 갱신 패턴 ──
  const addCheckItem = async (cardId: string, text: string, parentItemId?: string) => {
    try {
      const created = await createKanbanChecklistItem(cardId, text, parentItemId);
      setCheckItems(is => [...is, created]);
    } catch (e) { notifyError("체크리스트 항목 추가 실패")(e); }
  };
  const toggleCheckItem = (id: string, completed: boolean) => {
    setCheckItems(is => is.map(i => i.id === id ? { ...i, completed } : i));
    toggleKanbanChecklistItemRow(id, completed).catch(notifyError("체크리스트 저장 실패"));
  };
  const deleteCheckItem = (id: string) => {
    // DB FK 가 ON DELETE CASCADE 라 하위 항목도 함께 지워짐 — 로컬 상태에서도 자손을 전부 수집해 제거.
    setCheckItems(is => {
      const toRemove = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const it of is) {
          if (it.parentItemId && toRemove.has(it.parentItemId) && !toRemove.has(it.id)) {
            toRemove.add(it.id); grew = true;
          }
        }
      }
      return is.filter(i => !toRemove.has(i.id));
    });
    deleteKanbanChecklistItemRow(id).catch(notifyError("체크리스트 삭제 실패"));
  };

  // 카드 위 미리보기용 — 해당 카드의 체크리스트를 DFS 순서(부모 뒤에 자식, 깊이 포함)로 평탄화.
  const flattenChecklist = (cardId: string): { item: KanbanChecklistItem; depth: number }[] => {
    const list = checkItems.filter(i => i.cardId === cardId);
    const out: { item: KanbanChecklistItem; depth: number }[] = [];
    const walk = (parentId: string | undefined, depth: number) => {
      for (const it of list.filter(i => i.parentItemId === parentId)) {
        out.push({ item: it, depth });
        walk(it.id, depth + 1);
      }
    };
    walk(undefined, 0);
    return out;
  };

  const saveEdit = () => {
    if (!editingId || !editTitle.trim()) return;
    commitEdit(editingId);
    setEditingId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 pt-12 pb-8">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft size={14} /> 마감 작업 목록
        </button>

        {/* 헤더 — 목록 행과 같은 톤 언어(색 스트라이프 + D-day 배지).
             제목 클릭으로 인라인 편집, 날짜 옆 date picker 로 마감일 즉시 변경,
             팔레트 아이콘으로 마감 커스텀 색 지정(빈 값이면 D-day 톤을 자동으로 따라감).
             D-day 배지는 항상 남은 일수에 따른 톤(초록/노랑/주황/빨강)을 그대로 사용. */}
        <div className="flex items-center gap-3 mb-6 relative">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundColor: stripeColor }} />
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onFocus={e => e.currentTarget.select()}
                onBlur={commitTitle}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
                  else if (e.key === "Escape") { setTitleDraft(deadline.title); setEditingTitle(false); }
                }}
                className="w-full text-lg font-semibold bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 -mx-1"
              />
            ) : (
              <button
                onClick={() => { setTitleDraft(deadline.title); setEditingTitle(true); }}
                title="제목 편집"
                className="w-full text-left text-lg font-semibold truncate hover:bg-muted/40 rounded px-1 -mx-1 transition-colors"
              >{deadline.title}</button>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={deadline.dueDate}
                onChange={e => {
                  const v = e.target.value;
                  if (v && v !== deadline.dueDate) onUpdateDeadline(deadline.id, { dueDate: v });
                }}
                className="mt-0.5 text-[11px] text-muted-foreground bg-transparent outline-none hover:text-foreground focus:text-foreground transition-colors cursor-pointer"
                title="마감일 변경"
              />
              <button
                type="button"
                onClick={() => { setShowPalette(v => !v); setShowDeadlineCustomColor(false); }}
                title="마감 색상"
                className={`mt-0.5 p-1 rounded transition-colors ${showPalette ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              >
                <Palette size={13} />
              </button>
            </div>
          </div>
          <span
            className="text-[11px] px-2.5 py-1 rounded-full font-medium flex-shrink-0"
            style={{ backgroundColor: color + "22", color }}
          >
            {formatDDay(dl)}
          </span>
          {/* 팔레트 팝오버 — 카드 편집 폼과 같은 스와치 UI 를 재사용.
               "기본" 스와치는 색을 비우고 D-day 톤을 자동으로 따라가게 함. */}
          {showPalette && (
            <div className="absolute right-0 top-full mt-2 z-20 p-3 rounded-lg border bg-card shadow-lg w-64 space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">마감 색상</div>
              <div className="flex flex-wrap gap-1.5 items-center py-0.5">
                <button
                  type="button"
                  onClick={() => { if (deadline.color) onUpdateDeadline(deadline.id, { color: "" }); }}
                  className={`size-4 rounded-full border border-dashed border-foreground/50 transition-transform flex-shrink-0 ${deadline.color === "" ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                  style={{ backgroundColor: color }}
                  title="기본 (D-day 톤)"
                />
                {paletteColors.map(c => (
                  <div key={c} className="relative group/color size-4 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => { if (deadline.color.toLowerCase() !== c.toLowerCase()) onUpdateDeadline(deadline.id, { color: c }); }}
                      className={`size-4 rounded-full transition-transform ${deadline.color.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                      className="absolute -top-1 -right-1 size-3 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                      title="팔레트에서 제거"
                    >
                      <X size={7} strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setShowDeadlineCustomColor(v => !v)}
                  className={`size-4 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showDeadlineCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                  title="사용자 지정 색상 추가"
                >
                  <Plus size={9} className={showDeadlineCustomColor ? "text-primary" : "text-muted-foreground"} />
                </button>
              </div>
              {showDeadlineCustomColor && (
                <CustomColorPickerInline
                  initial={deadline.color || color}
                  onAdd={(c) => { onUpdateDeadline(deadline.id, { color: c }); onAddPaletteColor(c); }}
                  onClose={() => setShowDeadlineCustomColor(false)}
                />
              )}
              <button
                type="button"
                onClick={() => { setShowPalette(false); setShowDeadlineCustomColor(false); }}
                className="w-full text-[11px] py-1.5 rounded-md bg-muted hover:bg-muted/70 transition-colors"
              >닫기</button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 items-start">
          {KANBAN_COLUMNS.map(({ status, label }) => {
            const colCards = cards.filter(c => c.status === status).sort((a, b) => a.sortOrder - b.sortOrder);
            return (
              <div
                key={status}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverCol(status); }}
                onDragLeave={() => setDragOverCol(col => (col === status ? null : col))}
                onDrop={e => {
                  e.preventDefault();
                  setDragOverCol(null);
                  // 다른 컬럼으로 이동 시 소스 카드가 언마운트되어 onDragEnd 가 발화하지
                  // 않는 경우가 있음 — dragCardId 를 여기서도 정리해 새 위치 카드가
                  // opacity 0.3 으로 남는 것을 방지.
                  setDragCardId(null);
                  const id = e.dataTransfer.getData("kanbanCardId");
                  if (id) moveCard(id, status);
                }}
                className={`flex flex-col rounded-xl bg-muted/40 p-3 min-h-[220px] transition-colors ${dragOverCol === status ? "ring-2 ring-primary/40 bg-muted/70" : ""}`}
              >
                <div className="flex items-center gap-2 mb-3 px-1">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{colCards.length}</span>
                </div>

                <div className="space-y-2 flex-1">
                  {colCards.map(card => {
                    // 카드 개별 색이 있으면 그것, 없으면 마감의 유효 색(커스텀 색 또는 D-day 톤).
                    const cardColor = card.color || stripeColor;
                    const checklist = flattenChecklist(card.id);

                    // 클릭으로 편집 중 — 카드 자리를 인라인 폼으로 대체.
                    if (editingId === card.id) {
                      return (
                        <div key={card.id} className="p-2.5 rounded-lg border bg-card space-y-1.5"
                          style={{ borderLeft: `3px solid ${editColor || stripeColor}` }}>
                          <input
                            autoFocus
                            value={editTitle}
                            onChange={e => setEditTitle(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) saveEdit();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            placeholder="제목..."
                            className="w-full text-xs px-2.5 py-1.5 rounded-md bg-muted outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                          />
                          <textarea
                            value={editContent}
                            onChange={e => setEditContent(e.target.value)}
                            onKeyDown={e => { if (e.key === "Escape") setEditingId(null); }}
                            placeholder="내용 (선택)..."
                            rows={3}
                            className="w-full text-[11px] px-2.5 py-1.5 rounded-md bg-muted outline-none focus:ring-2 focus:ring-ring resize-none placeholder:text-muted-foreground"
                          />
                          {/* 색상 — 첫 스와치는 "기본"(마감 D-day 톤을 따라감), 나머지는 앱 공용 팔레트.
                               스와치 호버 X 로 팔레트에서 제거, + 로 커스텀 hex 색을 추가(팔레트에 저장돼
                               캘린더 블록/카테고리 색 선택에도 함께 나타남). */}
                          <div className="flex flex-wrap gap-1.5 items-center py-0.5">
                            <button
                              type="button"
                              onClick={() => setEditColor("")}
                              className={`size-4 rounded-full border border-dashed border-foreground/50 transition-transform flex-shrink-0 ${editColor === "" ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                              style={{ backgroundColor: stripeColor }}
                              title="기본 (마감 색)"
                            />
                            {paletteColors.map(c => (
                              <div key={c} className="relative group/color size-4 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={() => setEditColor(c)}
                                  className={`size-4 rounded-full transition-transform ${editColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                                  style={{ backgroundColor: c }}
                                  title={c}
                                />
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                                  className="absolute -top-1 -right-1 size-3 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                                  title="팔레트에서 제거"
                                >
                                  <X size={7} strokeWidth={2.5} />
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              onClick={() => setShowCustomColor(v => !v)}
                              className={`size-4 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                              title="사용자 지정 색상 추가"
                            >
                              <Plus size={9} className={showCustomColor ? "text-primary" : "text-muted-foreground"} />
                            </button>
                          </div>
                          {showCustomColor && (
                            <CustomColorPickerInline
                              initial={editColor || stripeColor}
                              onAdd={(c) => { setEditColor(c); onAddPaletteColor(c); }}
                              onClose={() => setShowCustomColor(false)}
                            />
                          )}
                          {/* 체크리스트 — 블록 바로 아래 단계만 추가 가능. 하위 항목 중첩은 지원하지 않음.
                               항목 추가/토글/삭제는 저장 버튼과 무관하게 즉시 반영. */}
                          <div className="pt-0.5">
                            <div className="text-[10px] font-medium text-muted-foreground mb-1">체크리스트</div>
                            <div className="space-y-0.5">
                              {checkItems.filter(i => i.cardId === card.id && !i.parentItemId).map(item => (
                                <ChecklistNode
                                  key={item.id}
                                  item={item}
                                  items={checkItems.filter(i => i.cardId === card.id)}
                                  depth={0}
                                  onToggle={toggleCheckItem}
                                  onDelete={deleteCheckItem}
                                />
                              ))}
                              <NewChecklistItemForm onAdd={text => addCheckItem(card.id, text)} />
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={saveEdit}
                              disabled={!editTitle.trim()}
                              className="flex-1 text-[11px] py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                            >저장</button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="flex-1 text-[11px] py-1.5 rounded-md bg-muted hover:bg-muted/70 transition-colors"
                            >취소</button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={card.id}
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData("kanbanCardId", card.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragCardId(card.id);
                        }}
                        onDragEnd={() => { setDragCardId(null); setDragOverCol(null); }}
                        onDragOver={e => { e.preventDefault(); }}
                        onDrop={e => {
                          // 카드 위에 드롭 — 컬럼 핸들러(맨 아래 추가)로 버블링되지 않게 여기서 소비.
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverCol(null);
                          // 소스 카드가 재정렬로 언마운트/리마운트되면서 onDragEnd 가 유실될
                          // 수 있음 — 방어적으로 dragCardId 를 여기서도 정리.
                          setDragCardId(null);
                          const id = e.dataTransfer.getData("kanbanCardId");
                          if (!id) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          reorderCard(id, card.id, e.clientY < rect.top + rect.height / 2);
                        }}
                        onClick={() => startEdit(card)}
                        className="group/kcard relative rounded-lg overflow-hidden cursor-grab select-none hover:brightness-95 transition-all"
                        style={{
                          backgroundColor: cardColor + "28",
                          borderLeft: `3px solid ${cardColor}`,
                          opacity: dragCardId === card.id ? 0.3 : 1,
                        }}
                      >
                        <div className="px-2.5 py-2">
                          <div className="text-xs font-semibold break-words pr-4" style={{ color: cardColor }}>{card.title}</div>
                          {card.content && (
                            <div className="text-[11px] opacity-70 mt-0.5 whitespace-pre-wrap break-words" style={{ color: cardColor }}>
                              {card.content}
                            </div>
                          )}
                          {/* 체크리스트 미리보기 — 카드에서 바로 토글 가능. 추가/삭제는 클릭(편집 폼)에서.
                               카드가 과하게 길어지지 않게 5개까지만 표시, 나머지는 개수로 접음. */}
                          {checklist.length > 0 && (
                            <div className="mt-1.5 space-y-0.5">
                              {checklist.slice(0, 5).map(({ item, depth }) => (
                                <div key={item.id} className="flex items-center gap-1.5 min-w-0" style={{ marginLeft: depth * 12 }}>
                                  <button
                                    onClick={e => { e.stopPropagation(); toggleCheckItem(item.id, !item.completed); }}
                                    className="flex-shrink-0"
                                  >
                                    {item.completed
                                      ? <CheckCircle2 size={11} style={{ color: cardColor }} />
                                      : <Circle size={11} className="opacity-60" style={{ color: cardColor }} />}
                                  </button>
                                  <span
                                    className={`text-[10px] truncate ${item.completed ? "line-through opacity-50" : "opacity-80"}`}
                                    style={{ color: cardColor }}
                                  >
                                    {item.text}
                                  </span>
                                </div>
                              ))}
                              {checklist.length > 5 && (
                                <div className="text-[10px] opacity-50 pl-[17px]" style={{ color: cardColor }}>
                                  +{checklist.length - 5}개 · {checklist.filter(c => c.item.completed).length}/{checklist.length} 완료
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); deleteCard(card.id); }}
                          className="absolute top-1 right-1 size-4 rounded flex items-center justify-center opacity-0 group-hover/kcard:opacity-100 hover:bg-black/20 transition-opacity"
                          title="작업 삭제"
                        >
                          <X size={9} style={{ color: cardColor }} />
                        </button>
                      </div>
                    );
                  })}
                  {!loading && colCards.length === 0 && addingCol !== status && (
                    <div className="text-[11px] text-muted-foreground/60 text-center py-4 select-none">작업 없음</div>
                  )}
                </div>

                {addingCol === status ? (
                  <div className="mt-2 p-2.5 rounded-lg border bg-card space-y-1.5"
                    style={{ borderLeft: `3px solid ${newColor || stripeColor}` }}>
                    <input
                      autoFocus
                      value={newTitle}
                      onChange={e => setNewTitle(e.target.value)}
                      onKeyDown={e => {
                        // 한글 IME 조합 중 Enter 는 keydown 이 두 번 와서 중복 추가됨 — 조합 중이면 무시.
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) addCard(status);
                        if (e.key === "Escape") setAddingCol(null);
                      }}
                      placeholder="제목..."
                      className="w-full text-xs px-2.5 py-1.5 rounded-md bg-muted outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                    />
                    <textarea
                      value={newContent}
                      onChange={e => setNewContent(e.target.value)}
                      onKeyDown={e => { if (e.key === "Escape") setAddingCol(null); }}
                      placeholder="내용 (선택)..."
                      rows={2}
                      className="w-full text-[11px] px-2.5 py-1.5 rounded-md bg-muted outline-none focus:ring-2 focus:ring-ring resize-none placeholder:text-muted-foreground"
                    />
                    {/* 색상 — 편집 폼과 동일한 팔레트 UI. 첫 스와치는 마감의 유효 색(커스텀 또는 D-day 톤)을 따라감. */}
                    <div className="flex flex-wrap gap-1.5 items-center py-0.5">
                      <button
                        type="button"
                        onClick={() => setNewColor("")}
                        className={`size-4 rounded-full border border-dashed border-foreground/50 transition-transform flex-shrink-0 ${newColor === "" ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                        style={{ backgroundColor: stripeColor }}
                        title="기본 (마감 색)"
                      />
                      {paletteColors.map(c => (
                        <div key={c} className="relative group/color size-4 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => setNewColor(c)}
                            className={`size-4 rounded-full transition-transform ${newColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                            style={{ backgroundColor: c }}
                            title={c}
                          />
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                            className="absolute -top-1 -right-1 size-3 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                            title="팔레트에서 제거"
                          >
                            <X size={7} strokeWidth={2.5} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setShowNewCustomColor(v => !v)}
                        className={`size-4 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showNewCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                        title="사용자 지정 색상 추가"
                      >
                        <Plus size={9} className={showNewCustomColor ? "text-primary" : "text-muted-foreground"} />
                      </button>
                    </div>
                    {showNewCustomColor && (
                      <CustomColorPickerInline
                        initial={newColor || stripeColor}
                        onAdd={(c) => { setNewColor(c); onAddPaletteColor(c); }}
                        onClose={() => setShowNewCustomColor(false)}
                      />
                    )}
                    {/* 체크리스트 — 카드가 아직 없어 로컬 버퍼에만 쌓아두고 추가 시점에 일괄 저장. */}
                    <div className="pt-0.5">
                      <div className="text-[10px] font-medium text-muted-foreground mb-1">체크리스트</div>
                      <div className="space-y-0.5">
                        {newChecklist.filter(i => !i.parentItemId).map(item => (
                          <ChecklistNode
                            key={item.id}
                            item={item}
                            items={newChecklist}
                            depth={0}
                            onToggle={toggleNewCheckItem}
                            onDelete={deleteNewCheckItem}
                          />
                        ))}
                        <NewChecklistItemForm onAdd={text => addNewCheckItem(text)} />
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => addCard(status)}
                        disabled={!newTitle.trim()}
                        className="flex-1 text-[11px] py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                      >추가</button>
                      <button
                        onClick={() => { setAddingCol(null); setNewTitle(""); setNewContent(""); setNewColor(""); setShowNewCustomColor(false); setNewChecklist([]); }}
                        className="flex-1 text-[11px] py-1.5 rounded-md bg-muted hover:bg-muted/70 transition-colors"
                      >취소</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAddingCol(status); setNewTitle(""); setNewContent(""); setNewColor(""); setShowNewCustomColor(false); setNewChecklist([]); }}
                    className="flex items-center justify-center gap-1.5 w-full mt-2 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                  >
                    <Plus size={12} /> 작업 추가
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Activity Record Section (v3: monthly calendar) ────────────────
function GrassSection({
  completionRate, blocks, templates, timerSec, totalPlanMin, focusSecByDate,
}: {
  completionRate: number;
  blocks: Block[];
  templates: Template[];
  timerSec: number;
  totalPlanMin: number;
  focusSecByDate: Record<string, number>;
}) {
  // 오늘이 속한 달을 기본값으로 — 이전에 2026/7 하드코드였던 자리. 앱 첫 마운트 시점의
  // 실제 날짜를 사용해야 배포 후에도 계속 현재 달이 열림.
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [goalMin, setGoalMin] = useState(totalPlanMin);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState(String((totalPlanMin / 60).toFixed(1)));
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const focusedMin = Math.floor(timerSec / 60);
  const goalProgress = goalMin > 0 ? Math.min(Math.round((focusedMin / goalMin) * 100), 100) : 0;

  const handleGoalSave = (e: React.FormEvent) => {
    e.preventDefault();
    setGoalMin(Math.round((parseFloat(goalInput) || 0) * 60));
    setEditingGoal(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  // Build day grid for viewed month
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dayStrings: (string | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(viewYear, viewMonth, i + 1);
      return toDateStr(d);
    }),
  ];
  while (dayStrings.length % 7 !== 0) dayStrings.push(null);

  // 그 날짜의 완료된 블록 목록과 총 집중 시간(분)을 실제 데이터에서 계산.
  // 오늘은 실시간 timerSec을 쓰고, 과거는 timer_sessions에서 집계한 focusSecByDate를 사용.
  const getDayData = (dateStr: string): {
    activities: { title: string; color: string }[];
    focusMin: number;
    goalMet: boolean;
  } => {
    if (dateStr === TODAY_STR) {
      // 오늘 분기도 반드시 date 필터를 함께 걸어야 함. 예전엔 `b.completed`만 걸어서
      // 지난 몇 달간의 모든 완료 블록이 오늘 셀에 activities로 나오고, activeDays 계산도
      // 왜곡되던 버그가 있었음.
      const completedBlocks = blocks.filter(b => b.date === dateStr && b.completed);
      return {
        activities: completedBlocks.map(b => ({ title: b.title, color: getCategoryColor(templates, b.category) })),
        focusMin: focusedMin,
        goalMet: focusedMin >= goalMin && goalMin > 0,
      };
    }
    if (dateStr > TODAY_STR) return { activities: [], focusMin: 0, goalMet: false };
    const completed = blocks.filter(b => b.date === dateStr && b.completed);
    const fm = Math.floor((focusSecByDate[dateStr] ?? 0) / 60);
    return {
      activities: completed.map(b => ({ title: b.title, color: getCategoryColor(templates, b.category) })),
      focusMin: fm,
      goalMet: fm >= goalMin && goalMin > 0,
    };
  };

  // Monthly summary stats
  const monthDays = dayStrings.filter((d): d is string => d !== null && d <= TODAY_STR);
  const achievedDays = monthDays.filter(d => getDayData(d).goalMet).length;
  const activeDays = monthDays.filter(d => getDayData(d).activities.length > 0).length;

  // 오늘까지 이어지는 연속 목표 달성 일수 — 오늘이 아직 달성 안 됐어도 어제 이전 스트릭은
  // 살아있는 것으로 취급 (오늘 시간이 남았으니 유예). 뷰 월과 무관하게 실제 오늘 기준으로 계산.
  const currentStreak = (() => {
    let streak = 0;
    const cur = parseLocalDate(TODAY_STR);
    for (let i = 0; i < 366; i++) {
      const dstr = toDateStr(cur);
      const isToday = dstr === TODAY_STR;
      const met = getDayData(dstr).goalMet;
      if (met) streak++;
      else if (!isToday) break;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  })();

  // "태그별 오늘 현황" 헤더에 맞춰 오늘 블록만 집계. 예전엔 전체 기간을 집계해서
  // 하루가 지날수록 total이 쌓이고 비율이 실제 오늘 현황과 무관해지던 버그가 있었음.
  const todaysBlocks = blocks.filter(b => b.date === TODAY_STR);
  const tagStats = [
    { tag: "공부", color: "#5B7EA8" },
    { tag: "개발", color: "#7B5EA7" },
    { tag: "루틴", color: "#C89A2E" },
    { tag: "운동", color: "#D4622A" },
  ].map(({ tag, color }) => ({
    tag, color,
    done: todaysBlocks.filter(b => b.completed && b.tags.includes(tag)).length,
    total: todaysBlocks.filter(b => b.tags.includes(tag)).length,
  })).filter(t => t.total > 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {/* Checklist completion */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-3">오늘 체크리스트 달성률</div>
            <div className="flex items-end gap-3">
              <div className="text-3xl font-semibold">{completionRate}%</div>
              <CircleProgress value={completionRate} size={44} />
            </div>
            <div className="mt-3 h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completionRate}%` }} />
            </div>
          </div>

          {/* Focus time vs editable goal */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-1">오늘 집중 시간</div>
            <div className="text-3xl font-semibold mt-1" >
              {fmt2(Math.floor(focusedMin / 60))}<span className="text-base font-normal text-muted-foreground">h </span>
              {fmt2(focusedMin % 60)}<span className="text-base font-normal text-muted-foreground">m</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-[11px] text-muted-foreground">목표</span>
              {editingGoal ? (
                <form onSubmit={handleGoalSave} className="flex items-center gap-1">
                  <input
                    autoFocus
                    type="number" step="0.5"
                    value={goalInput}
                    onChange={e => setGoalInput(e.target.value)}
                    className="w-14 px-1.5 py-0.5 text-xs rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                                     />
                  <span className="text-[11px] text-muted-foreground">시간</span>
                  <button type="submit" className="p-0.5 text-sky-600 hover:text-sky-700"><Check size={12} /></button>
                </form>
              ) : (
                <button
                  onClick={() => { setGoalInput(String((goalMin / 60).toFixed(1))); setEditingGoal(true); }}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground group"
                >
                  <span >
                    {Math.floor(goalMin / 60)}h{goalMin % 60 > 0 ? ` ${goalMin % 60}m` : ""}
                  </span>
                  <Edit3 size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              {!editingGoal && goalMin === totalPlanMin && (
                <span className="text-[10px] text-muted-foreground/50">(자동)</span>
              )}
            </div>
            <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-blue-400 transition-all" style={{ width: `${goalProgress}%` }} />
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">{goalProgress}%</div>
          </div>

          {/* This month summary */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1">
              <Flame size={11} /> 연속 일수
            </div>
            <div className="text-3xl font-semibold mt-2">{currentStreak}일</div>
            <div className="text-[11px] text-muted-foreground mt-1">이번 달 {activeDays}일 활동</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">목표 달성 {achievedDays}일</div>
          </div>
        </div>

        {/* Monthly calendar */}
        <div className="rounded-xl border bg-card overflow-hidden mb-4">
          {/* Month nav header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded hover:bg-muted transition-colors"
            >
              <ChevronLeft size={15} className="text-muted-foreground" />
            </button>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">{viewYear}년 {viewMonth + 1}월</span>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block size-2.5 rounded-sm bg-sky-100 border border-sky-300" />
                  목표 달성일
                </span>
              </div>
            </div>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded hover:bg-muted transition-colors"
            >
              <ChevronRight size={15} className="text-muted-foreground" />
            </button>
          </div>

          {/* Day of week headers */}
          <div className="grid grid-cols-7 border-b border-border">
            {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
              <div key={d} className={`text-center text-[10px] py-2 font-medium ${i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                {d}
              </div>
            ))}
          </div>

          {/* Calendar cells */}
          <div className="grid grid-cols-7">
            {dayStrings.map((dateStr, i) => {
              if (!dateStr) {
                return (
                  <div
                    key={`empty-${i}`}
                    className={`min-h-[90px] border-border ${i % 7 !== 6 ? "border-r" : ""} ${i < dayStrings.length - 7 ? "border-b" : ""}`}
                  />
                );
              }

              const data = getDayData(dateStr);
              const isToday = dateStr === TODAY_STR;
              const isFuture = dateStr > TODAY_STR;
              const dayNum = parseLocalDate(dateStr).getDate();
              const dow = parseLocalDate(dateStr).getDay();
              const MAX_SHOWN = 3;
              const shown = data.activities.slice(0, MAX_SHOWN);
              const overflow = data.activities.length - MAX_SHOWN;
              const isExpanded = expandedDate === dateStr;
              const allShown = isExpanded ? data.activities : shown;
              const col = i % 7;
              const row = Math.floor(i / 7);
              const totalRows = Math.floor(dayStrings.length / 7);

              return (
                <div
                  key={dateStr}
                  className={`min-h-[90px] p-2 relative transition-colors ${
                    col !== 6 ? "border-r border-border" : ""
                  } ${
                    row < totalRows - 1 ? "border-b border-border" : ""
                  } ${
                    data.goalMet ? "bg-sky-50/70" : ""
                  } ${
                    isFuture ? "bg-muted/10" : ""
                  } ${
                    isToday ? "ring-1 ring-inset ring-primary/30" : ""
                  }`}
                >
                  {/* Date number */}
                  <div className="flex items-center justify-between mb-1.5">
                    <span
                      className={`text-xs font-medium inline-flex items-center justify-center ${
                        isToday
                          ? "size-5 rounded-full bg-primary text-primary-foreground text-[10px]"
                          : isHoliday(dateStr) || dow === 0 ? "text-red-400" : dow === 6 ? "text-blue-400" : "text-muted-foreground"
                      }`}
                      title={getHoliday(dateStr) ?? undefined}
                    >
                      {dayNum}
                    </span>
                    {data.goalMet && (
                      <span className="text-[9px] text-sky-600 font-medium">✓</span>
                    )}
                  </div>

                  {/* Focus time — shown first */}
                  {!isFuture && data.focusMin > 0 && (
                    <div
                      className="text-[9px] font-semibold mb-0.5"
                      style={{ color: data.goalMet ? "#16a34a" : undefined }}
                    >
                      {Math.floor(data.focusMin / 60)}h{data.focusMin % 60 > 0 ? ` ${data.focusMin % 60}m` : ""}
                    </div>
                  )}

                  {/* Activities list — below focus time */}
                  {!isFuture && data.activities.length > 0 && (
                    <div className="space-y-0.5">
                      {allShown.map((act, ai) => (
                        <div key={ai} className="flex items-center gap-1 min-w-0">
                          <span className="size-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: act.color }} />
                          <span className="text-[9px] leading-tight truncate text-foreground/70">{act.title}</span>
                        </div>
                      ))}
                      {overflow > 0 && !isExpanded && (
                        <button onClick={() => setExpandedDate(dateStr)} className="text-[9px] text-muted-foreground hover:text-foreground transition-colors">
                          +{overflow}개
                        </button>
                      )}
                      {isExpanded && (
                        <button onClick={() => setExpandedDate(null)} className="text-[9px] text-muted-foreground hover:text-foreground transition-colors">
                          접기
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tag breakdown */}
        {tagStats.length > 0 && (
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-4">태그별 오늘 현황</div>
            <div className="space-y-3.5">
              {tagStats.map(({ tag, color, done, total }) => (
                <div key={tag} className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 w-14">
                    <span className="size-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-[11px] text-muted-foreground">{tag}</span>
                  </div>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${total > 0 ? (done / total) * 100 : 0}%`, backgroundColor: color }} />
                  </div>
                  <span className="text-[11px] text-muted-foreground w-8 text-right flex-shrink-0" >
                    {done}/{total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memo Section — 메모장 (리스트 · 폴더 · 카테고리 · 정렬 · 드래그) ─────
type SortMode = "custom" | "title-asc" | "title-desc" | "date-asc" | "date-desc";
const SORT_LABELS: Record<SortMode, string> = {
  "custom": "사용자 지정순",
  "title-asc": "제목 ↑",
  "title-desc": "제목 ↓",
  "date-asc": "날짜 ↑ (오래된순)",
  "date-desc": "날짜 ↓ (최신순)",
};
// 폴더 색상 팔레트
const FOLDER_COLORS = ["#5AA9E6", "#7CC0F0", "#A78BFA", "#F7A8B8", "#FCB86B", "#4E8B6E", "#C89A2E", "#B05A7A"];
// 블록/템플릿 프리셋 팔레트 — 파스텔 블루 톤을 축으로 대비색 몇 가지를 섞음.
// 사용자가 '+' 버튼으로 커스텀 색을 추가/삭제할 수 있으며, 현재 팔레트는
// localStorage에 저장되어 재실행 시에도 유지됨.
const DEFAULT_BLOCK_COLORS = ["#5AA9E6", "#7CC0F0", "#A78BFA", "#F7A8B8", "#FCB86B", "#6EE7B7", "#C89A2E", "#B05A7A"];
const BLOCK_PALETTE_KEY = "block_palette_colors";

// 앱 전역 커스텀 툴팁 — [title] 속성이 붙은 아무 요소든 호버하면 native OS 툴팁 대신
// 앱 톤에 맞는 스타일드 툴팁을 띄움. 기존 코드베이스의 title="..." 33개를 손대지 않고
// 한 곳에서 룩앤필을 통일하기 위해 mouseover/out 캡처 리스너로 개입하는 방식.
// - mouseover 시 title 속성을 순간적으로 비워 native 툴팁이 뜨는 걸 억제하고
//   원본 값은 ref에 백업 → mouseout에서 복원 → 컴포넌트가 언마운트돼도 원상복구
// - 350ms delay: 마우스가 스쳐 지나가는 경우엔 안 뜨게
// - 위치: 트리거 요소 하단 중앙 8px 아래, 뷰포트 하단에 걸리면 위로 뒤집힘
function AppTooltipRoot() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; placement: "below" | "above" } | null>(null);
  const currentEl = useRef<HTMLElement | null>(null);
  const originalTitle = useRef<string | null>(null);
  const showTimer = useRef<number | null>(null);

  useEffect(() => {
    const restore = () => {
      if (currentEl.current && originalTitle.current !== null) {
        try { currentEl.current.setAttribute("title", originalTitle.current); } catch {}
      }
      currentEl.current = null;
      originalTitle.current = null;
    };
    const clearAll = () => {
      if (showTimer.current !== null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
      restore();
      setTip(null);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const el = t.closest("[title]") as HTMLElement | null;
      if (!el) { clearAll(); return; }
      if (el === currentEl.current) return;
      // 다른 요소로 옮겨감 — 기존 타이머·툴팁 정리
      if (showTimer.current !== null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
      restore();
      setTip(null);
      const raw = el.getAttribute("title");
      if (!raw) return;
      currentEl.current = el;
      originalTitle.current = raw;
      try { el.setAttribute("title", ""); } catch {}
      showTimer.current = window.setTimeout(() => {
        if (!currentEl.current) return;
        const rect = currentEl.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const belowY = rect.bottom + 8;
        const wouldOverflow = belowY + 40 > window.innerHeight;
        setTip({
          text: raw,
          x: centerX,
          y: wouldOverflow ? rect.top - 8 : belowY,
          placement: wouldOverflow ? "above" : "below",
        });
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!currentEl.current) return;
      if (related && currentEl.current.contains(related)) return;
      clearAll();
    };
    const onDown = () => clearAll();
    const onScroll = () => clearAll();

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      clearAll();
    };
  }, []);

  if (!tip) return null;
  // document.body 에 portal — #root 에 걸린 CSS zoom(글씨 크기) 이 fixed 좌표에 이중으로
  // 곱해지는 걸 피하기 위함. getBoundingClientRect 는 이미 zoom 이 반영된 시각 px 를
  // 반환하므로, zoom 이 없는 body 안에서 fixed 로 그대로 사용해야 위치가 일치함.
  return createPortal(
    <div
      style={{
        position: "fixed",
        left: tip.x,
        top: tip.y,
        transform: tip.placement === "below" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        zIndex: 9999,
      }}
      className="pointer-events-none rounded-lg bg-foreground/95 text-background text-[11px] font-medium px-2.5 py-1 shadow-lg max-w-[240px] whitespace-normal leading-snug"
    >
      {tip.text}
    </div>,
    document.body,
  );
}

// 팔레트에 커스텀 색을 추가할 때 뜨는 인라인 편집 카드.
// native color picker의 onChange가 슬라이더 이동마다 마구 발동해 팔레트가 도배되는
// 문제를 막기 위해, 여기서 draft만 갱신하고 "추가" 버튼을 눌러야만 실제 팔레트에 등록됨.
function CustomColorPickerInline({ initial, onAdd, onClose }: {
  initial: string;
  onAdd: (color: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const isValid = /^#[0-9a-fA-F]{6}$/.test(draft.trim());
  const normalized = draft.trim();
  const confirm = () => { if (isValid) { onAdd(normalized); onClose(); } };
  const swatchColor = isValid ? normalized : "#5AA9E6";
  return (
    <div className="mt-2.5 p-2.5 rounded-xl border border-border bg-muted/30 space-y-2">
      <div className="flex items-center gap-2">
        <label
          className="relative size-8 rounded-lg cursor-pointer border border-border/60 flex-shrink-0 hover:opacity-80 transition-opacity"
          style={{ backgroundColor: swatchColor }}
          title="색상 대화상자 열기"
        >
          <input
            type="color"
            value={swatchColor}
            onChange={e => setDraft(e.target.value)}
            className="sr-only"
          />
        </label>
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); confirm(); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder="#5AA9E6"
          maxLength={7}
          className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-lg bg-card border border-border outline-none focus:ring-1 focus:ring-ring font-mono uppercase"
        />
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={confirm}
          disabled={!isValid}
          className="flex-1 text-[11px] py-1.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40 transition-opacity"
        >추가</button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 text-[11px] py-1.5 rounded-lg bg-muted hover:bg-muted/60 text-foreground font-medium transition-colors"
        >닫기</button>
      </div>
    </div>
  );
}

// 마크다운 프리뷰 공용 클래스
const PROSE_CLASS = "prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-li:my-1 prose-code:before:hidden prose-code:after:hidden prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-primary";

function MemoSection({
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
}: {
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null이면 리스트 뷰

  useEffect(() => {
    (async () => {
      try {
        const [ns, fs] = await Promise.all([fetchNotes(), fetchNoteFolders()]);
        setNotes(ns);
        setFolders(fs);
      } catch (e) {
        // 예전엔 console.error만 남기고 조용히 넘어가서, 로드 실패 시 사용자가 빈 메모 화면을
        // 보고 데이터가 사라진 줄 알 수 있었음. 토스트로 명시.
        notifyError("메모 불러오기 실패")(e);
      }
      setLoaded(true);
    })();
  }, []);

  const refreshNotes = async () => { try { setNotes(await fetchNotes()); } catch (e) { notifyError("메모 새로고침 실패")(e); } };
  const refreshFolders = async () => { try { setFolders(await fetchNoteFolders()); } catch (e) { notifyError("폴더 새로고침 실패")(e); } };

  // 현재 폴더 뷰 안에서 만들면 그 폴더에 속하게 함 — 루트 뷰나 임시 저장 뷰에선 folderId 없음.
  const handleCreateNote = async (folderId: string | null) => {
    try {
      const n = await createNote({ title: "", content: "", folderId });
      setNotes(ns => [n, ...ns]);
      setEditingId(n.id);
    } catch (e) { notifyError("새 메모 만들기 실패")(e); }
  };

  if (!loaded) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">불러오는 중…</div>;
  }

  const editingNote = notes.find(n => n.id === editingId) ?? null;
  if (editingNote) {
    return (
      <NoteEditor
        note={editingNote}
        folders={folders}
        allCategories={Array.from(new Set(notes.map(n => n.category).filter(Boolean)))}
        onBack={() => { setEditingId(null); refreshNotes(); }}
        onChangeLocal={patch => setNotes(ns => ns.map(x => x.id === editingNote.id ? { ...x, ...patch } : x))}
      />
    );
  }

  return (
    <NoteList
      notes={notes}
      folders={folders}
      onOpen={id => setEditingId(id)}
      onCreateNote={handleCreateNote}
      refreshNotes={refreshNotes}
      refreshFolders={refreshFolders}
      setNotes={setNotes}
      setFolders={setFolders}
      paletteColors={paletteColors}
      onAddPaletteColor={onAddPaletteColor}
      onRemovePaletteColor={onRemovePaletteColor}
    />
  );
}

// ── 메모 리스트 뷰 ──────────────────────────────────────────────────
function NoteList({
  notes, folders, onOpen, onCreateNote, refreshNotes, refreshFolders, setNotes, setFolders,
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
}: {
  notes: Note[];
  folders: NoteFolder[];
  onOpen: (id: string) => void;
  onCreateNote: (folderId: string | null) => void;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  setFolders: React.Dispatch<React.SetStateAction<NoteFolder[]>>;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
}) {
  const [sortMode, setSortMode] = useState<SortMode>("custom");
  const [sortOpen, setSortOpen] = useState(false);
  // viewFolderId: null이면 루트 뷰(폴더 카드 + 폴더 없는 노트), 폴더 id면 그 폴더의 노트만 노출.
  // "drafts" 센티널은 임시 저장 탭 — 아직 사용자가 "저장" 버튼으로 확정하지 않은 노트만 노출.
  // 예전엔 "전체 / 폴더 없음 / 각 폴더" 필터 칩 바가 있었는데, 폴더 자체를 리스트 아이템으로
  // 두고 클릭으로 진입하는 파일탐색기 스타일이 더 직관적이라 그렇게 재설계.
  const [viewFolderId, setViewFolderId] = useState<string | null | "drafts">(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [menuNoteId, setMenuNoteId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // 새 폴더 색상 기본값 — 공용 팔레트의 첫 항목(비어있으면 FOLDER_COLORS 첫 항목으로 폴백).
  const [newFolderColor, setNewFolderColor] = useState<string>(paletteColors[0] ?? FOLDER_COLORS[0]);
  const [showNewFolderCustomColor, setShowNewFolderCustomColor] = useState(false);
  // 편집 중인 폴더 id — 폴더 카드의 3-dot 메뉴에서 "이름·색상 편집" 클릭 시 세팅.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  // 삭제 확인 모달에 띄울 폴더 id — 확인 버튼을 눌러야 실제 삭제가 실행됨.
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  // 드래그 오버 중인 대상: 특정 폴더 id, "back"(뒤로가기 = 루트로 이동), null(없음)
  const [dropFolderId, setDropFolderId] = useState<string | "back" | null>(null);
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);
  // 폴더 카드 재정렬 시 드래그 중인 폴더 id — 노트 드래그와 분리해서 다뤄야 하고,
  // FolderCard 사이의 drop 대상 하이라이트/드래그 소스 tint 용.
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);

  const categories = Array.from(new Set(notes.map(n => n.category).filter(Boolean)));
  const inDrafts = viewFolderId === "drafts";
  const currentFolder = !inDrafts && viewFolderId ? folders.find(f => f.id === viewFolderId) ?? null : null;
  const draftCount = notes.filter(n => n.isDraft).length;

  // 필터: 임시 저장 탭에선 draft만, 그 외에선 draft를 숨기고 현재 뷰(루트=null 또는 폴더)에 속한 노트만.
  let shown = notes.filter(n => {
    if (inDrafts) {
      if (!n.isDraft) return false;
    } else {
      if (n.isDraft) return false;
      if (n.folderId !== viewFolderId) return false;
    }
    if (activeCategory && n.category !== activeCategory) return false;
    return true;
  });
  // 정렬
  shown = [...shown].sort((a, b) => {
    switch (sortMode) {
      case "title-asc": return (a.title || "제목 없음").localeCompare(b.title || "제목 없음");
      case "title-desc": return (b.title || "제목 없음").localeCompare(a.title || "제목 없음");
      case "date-asc": return a.updatedAt.localeCompare(b.updatedAt);
      case "date-desc": return b.updatedAt.localeCompare(a.updatedAt);
      default: return a.sortOrder - b.sortOrder;
    }
  });

  const handleMoveNote = async (noteId: string, folderId: string | null) => {
    setNotes(ns => ns.map(n => n.id === noteId ? { ...n, folderId } : n));
    try { await moveNoteToFolder(noteId, folderId); } catch (e) { notifyError("메모 이동 실패")(e); }
    setMenuNoteId(null);
  };

  const handleDeleteNote = async (noteId: string) => {
    setNotes(ns => ns.filter(n => n.id !== noteId));
    try { await deleteNote(noteId); } catch (e) { notifyError("메모 삭제 실패")(e); }
    setMenuNoteId(null);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try { await createFolder({ name, color: newFolderColor }); await refreshFolders(); } catch (e) { notifyError("폴더 만들기 실패")(e); }
    setNewFolderName(""); setNewFolderColor(paletteColors[0] ?? FOLDER_COLORS[0]); setShowNewFolder(false); setShowNewFolderCustomColor(false);
  };

  // 실제 삭제 실행 — 확인 모달의 "삭제" 버튼이나 확인이 필요없는 경로에서 호출.
  // deleteFolder 는 이제 내부 노트도 함께 삭제하므로 UI 상 노트 목록도 즉시 정리.
  const confirmDeleteFolder = async (folderId: string) => {
    if (viewFolderId === folderId) setViewFolderId(null);
    if (editingFolderId === folderId) setEditingFolderId(null);
    // 낙관적으로 UI 에서 폴더와 소속 노트를 먼저 제거 — 서버 재로딩 지연 없이 즉시 반영.
    setFolders(fs => fs.filter(f => f.id !== folderId));
    setNotes(ns => ns.filter(n => n.folderId !== folderId));
    try { await deleteFolder(folderId); } catch (e) {
      notifyError("폴더 삭제 실패")(e);
      // 실패 시 서버 상태로 되돌림.
      await Promise.all([refreshFolders(), refreshNotes()]);
    }
  };

  // 3-dot 메뉴/편집 폼의 "폴더 삭제" 버튼이 호출 — 실제 삭제 대신 확인 모달만 띄움.
  // 내부에 메모가 있든 없든 항상 경고를 노출해 사용자가 파괴적 동작임을 인지하게 함.
  const handleDeleteFolder = (folderId: string) => {
    setDeletingFolderId(folderId);
  };

  // 폴더 이름·색상 편집 저장 — 낙관적 업데이트 후 DB, 실패 시 서버 상태로 되돌림.
  const handleUpdateFolder = async (folderId: string, changes: { name?: string; color?: string }) => {
    setFolders(fs => fs.map(f => f.id === folderId ? { ...f, ...changes } : f));
    try { await updateFolder(folderId, changes); } catch (e) { notifyError("폴더 수정 실패")(e); await refreshFolders(); }
  };

  // 노트 카드 간 드래그로 재정렬 — 정렬 모드가 custom이 아니면 custom으로 전환
  const handleReorder = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ids = shown.map(n => n.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // shown에 없는(다른 폴더/카테고리) 노트는 뒤에 유지
    const rest = notes.map(n => n.id).filter(id => !ids.includes(id));
    const finalOrder = [...ids, ...rest];
    setSortMode("custom");
    setNotes(ns => [...ns].sort((a, b) => finalOrder.indexOf(a.id) - finalOrder.indexOf(b.id)).map((n, i) => ({ ...n, sortOrder: i })));
    try { await reorderNotes(finalOrder); } catch (e) { notifyError("메모 순서 저장 실패")(e); }
  };

  // 정렬된 폴더 목록 — 노트와 같은 sortMode 를 공유해 UI 상 일관되게 정렬.
  // 폴더에는 updated_at 이 없어서 date 축은 created_at 을 사용.
  const sortedFolders = [...folders].sort((a, b) => {
    switch (sortMode) {
      case "title-asc": return (a.name || "이름 없음").localeCompare(b.name || "이름 없음");
      case "title-desc": return (b.name || "이름 없음").localeCompare(a.name || "이름 없음");
      case "date-asc": return a.createdAt.localeCompare(b.createdAt);
      case "date-desc": return b.createdAt.localeCompare(a.createdAt);
      default: return a.sortOrder - b.sortOrder;
    }
  });

  // 폴더 카드 간 드래그로 재정렬 — 노트 재정렬과 동일한 패턴. custom 모드로 자동 전환.
  const handleReorderFolder = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ids = sortedFolders.map(f => f.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setSortMode("custom");
    setFolders(fs => [...fs].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((f, i) => ({ ...f, sortOrder: i })));
    try { await reorderFolders(ids); } catch (e) { notifyError("폴더 순서 저장 실패")(e); }
  };

  return (
    <div className="flex-1 overflow-y-auto" onClick={() => setMenuNoteId(null)}>
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Header — 타이틀 생략, 도구 버튼(정렬/새 폴더/새 메모)만 우측에 배치 */}
        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-2">
            {/* 정렬 드롭다운 */}
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); setSortOpen(v => !v); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-card text-xs hover:bg-muted transition-colors"
              >
                <ArrowUpDown size={13} /> {SORT_LABELS[sortMode]}
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-44 bg-card border border-border rounded-lg shadow-lg z-50 p-1">
                    {(Object.keys(SORT_LABELS) as SortMode[]).map(m => (
                      <button
                        key={m}
                        onClick={() => { setSortMode(m); setSortOpen(false); }}
                        className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors ${sortMode === m ? "text-primary font-medium" : "text-foreground"}`}
                      >
                        {SORT_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setShowNewFolder(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-card text-xs hover:bg-muted transition-colors"
            >
              <FolderPlus size={13} /> 새 폴더
            </button>
            <button
              // 폴더 뷰 안에서 만들면 그 폴더에 속하게 함. 루트/임시저장 뷰에선 folderId 없음.
              onClick={() => onCreateNote(currentFolder ? currentFolder.id : null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={13} /> 새 메모
            </button>
            {/* 임시 저장 탭 — 뒤로가기(자동 저장)로 남긴 미확정 노트만 모아 봄.
                 활성화되어 있으면 primary 톤으로 강조해 현재 뷰가 임시 저장 뷰임을 표시. */}
            <button
              onClick={() => setViewFolderId(inDrafts ? null : "drafts")}
              title={inDrafts ? "임시 저장 나가기" : "임시 저장 메모 보기"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                inDrafts
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card hover:bg-muted"
              }`}
            >
              <FileText size={13} /> 임시 저장
              {draftCount > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  inDrafts ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                }`}>{draftCount}</span>
              )}
            </button>
          </div>
        </div>

        {/* 새 폴더 인라인 폼 — 공용 팔레트(다른 블록과 동일한 색 목록)에서 선택.
             각 스와치는 호버 시 X 버튼으로 팔레트에서 제거 가능하고, 우측 + 로 커스텀 hex 색을 추가. */}
        {showNewFolder && (
          <div className="mb-4 p-4 rounded-xl border bg-card">
            <div className="flex items-center gap-2 mb-3">
              <input
                autoFocus
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
                placeholder="폴더 이름"
                className="flex-1 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
              />
              <button onClick={handleCreateFolder} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium">만들기</button>
              <button onClick={() => { setShowNewFolder(false); setShowNewFolderCustomColor(false); }} className="p-2 text-muted-foreground hover:text-foreground"><X size={14} /></button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {paletteColors.map(c => (
                <div key={c} className="relative group/color size-6 flex-shrink-0">
                  <button
                    onClick={() => setNewFolderColor(c)}
                    className={`size-6 rounded-full transition-transform ${newFolderColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-2 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                  <button
                    onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                    className="absolute -top-1 -right-1 size-3.5 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                    title="팔레트에서 제거"
                  >
                    <X size={8} strokeWidth={2.5} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setShowNewFolderCustomColor(v => !v)}
                className={`size-6 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showNewFolderCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                title="사용자 지정 색상 추가"
              >
                <Plus size={12} className={showNewFolderCustomColor ? "text-primary" : "text-muted-foreground"} />
              </button>
            </div>
            {showNewFolderCustomColor && (
              <div className="mt-2">
                <CustomColorPickerInline
                  initial={newFolderColor}
                  onAdd={(c) => { setNewFolderColor(c); onAddPaletteColor(c); }}
                  onClose={() => setShowNewFolderCustomColor(false)}
                />
              </div>
            )}
          </div>
        )}

        {/* 폴더 안이나 임시 저장 뷰면 뒤로가기 헤더 노출. 폴더 뷰의 뒤로가기 버튼은
             노트를 드래그해 드롭하면 루트(폴더 없음)로 꺼내는 드롭 타깃 역할도 겸함.
             임시 저장 뷰의 뒤로가기 버튼은 폴더 이동과 무관하므로 드롭 타깃은 아님. */}
        {(currentFolder || inDrafts) && (
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={() => setViewFolderId(null)}
              onDragOver={currentFolder ? e => { if (dragNoteId) { e.preventDefault(); setDropFolderId("back"); } } : undefined}
              onDragLeave={currentFolder ? () => setDropFolderId(null) : undefined}
              onDrop={currentFolder ? e => { e.preventDefault(); const id = e.dataTransfer.getData("noteId"); if (id) handleMoveNote(id, null); setDropFolderId(null); setViewFolderId(null); } : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                dropFolderId === "back" ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-card hover:bg-muted"
              }`}
            >
              <ArrowLeft size={13} /> 뒤로
            </button>
            {inDrafts ? (
              <div className="flex items-center gap-1.5 text-sm">
                <FileText size={14} className="text-muted-foreground" />
                <span className="font-medium">임시 저장</span>
                <span className="text-[11px] text-muted-foreground">{shown.length}</span>
              </div>
            ) : currentFolder && (
              <div className="flex items-center gap-1.5 text-sm">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: currentFolder.color }} />
                <span className="font-medium">{currentFolder.name}</span>
                <span className="text-[11px] text-muted-foreground">{shown.length}</span>
              </div>
            )}
          </div>
        )}

        {/* 카테고리 필터 칩 */}
        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-5">
            <span className="text-[10px] text-muted-foreground mr-1">카테고리</span>
            <button
              onClick={() => setActiveCategory(null)}
              className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${activeCategory === null ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >전체</button>
            {categories.map(c => (
              <button
                key={c}
                onClick={() => setActiveCategory(activeCategory === c ? null : c)}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${activeCategory === c ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}
              >{c}</button>
            ))}
          </div>
        )}

        {/* 목록: 루트 뷰에선 폴더 카드가 노트 위에 먼저 나오고, 폴더/임시 저장 안에선 노트만.
             폴더 카드에 노트를 드래그하면 그 폴더로 이동. */}
        {shown.length === 0 && (viewFolderId !== null || folders.length === 0) ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            {inDrafts
              ? "임시 저장된 메모가 없습니다. \"새 메모\"로 만든 뒤 \"저장\"을 누르지 않고 나가면 여기 모입니다."
              : notes.filter(n => !n.isDraft).length === 0 && folders.length === 0
              ? "아직 메모가 없습니다. \"새 메모\"로 첫 메모를 만들어보세요."
              : viewFolderId !== null
              ? "이 폴더에는 아직 메모가 없습니다. 다른 메모를 여기로 드래그해 옮길 수 있습니다."
              : "이 조건에 해당하는 메모가 없습니다."}
          </div>
        ) : (
          <div className="space-y-2">
            {viewFolderId === null && sortedFolders.map(f => (
              <FolderCard
                key={f.id}
                folder={f}
                count={notes.filter(n => n.folderId === f.id).length}
                isDropTarget={dropFolderId === f.id}
                isDragging={dragFolderId === f.id}
                isEditing={editingFolderId === f.id}
                paletteColors={paletteColors}
                onAddPaletteColor={onAddPaletteColor}
                onRemovePaletteColor={onRemovePaletteColor}
                onOpen={() => { if (editingFolderId !== f.id) setViewFolderId(f.id); }}
                onStartEdit={() => setEditingFolderId(f.id)}
                onCancelEdit={() => setEditingFolderId(null)}
                onSaveEdit={changes => { handleUpdateFolder(f.id, changes); setEditingFolderId(null); }}
                onDelete={() => handleDeleteFolder(f.id)}
                onDragStart={e => { e.dataTransfer.setData("folderId", f.id); e.dataTransfer.effectAllowed = "move"; setDragFolderId(f.id); }}
                onDragEnd={() => { setDragFolderId(null); setDropFolderId(null); }}
                // 노트 드롭(폴더 이동) 과 폴더 드롭(재정렬) 을 같은 자리에서 처리.
                onDragOver={e => {
                  if (dragNoteId) { e.preventDefault(); setDropFolderId(f.id); }
                  else if (dragFolderId && dragFolderId !== f.id) { e.preventDefault(); setDropFolderId(f.id); }
                }}
                onDragLeave={() => setDropFolderId(null)}
                onDrop={e => {
                  e.preventDefault();
                  const noteId = e.dataTransfer.getData("noteId");
                  const folderIdData = e.dataTransfer.getData("folderId");
                  if (noteId) { handleMoveNote(noteId, f.id); }
                  else if (folderIdData && folderIdData !== f.id) { handleReorderFolder(folderIdData, f.id); }
                  setDropFolderId(null);
                  setDragFolderId(null);
                }}
              />
            ))}
            {shown.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                folder={folders.find(f => f.id === n.folderId) ?? null}
                folders={folders}
                menuOpen={menuNoteId === n.id}
                onOpen={() => onOpen(n.id)}
                onToggleMenu={e => { e.stopPropagation(); setMenuNoteId(menuNoteId === n.id ? null : n.id); }}
                onMove={folderId => handleMoveNote(n.id, folderId)}
                onDelete={() => handleDeleteNote(n.id)}
                onDragStart={e => { e.dataTransfer.setData("noteId", n.id); setDragNoteId(n.id); }}
                onDragEnd={() => setDragNoteId(null)}
                onDragOverCard={e => { if (dragNoteId && dragNoteId !== n.id) e.preventDefault(); }}
                onDropCard={e => { e.preventDefault(); const id = e.dataTransfer.getData("noteId"); if (id) handleReorder(id, n.id); setDragNoteId(null); }}
              />
            ))}
          </div>
        )}
      </div>
      {/* 폴더 삭제 확인 — 내부 메모까지 함께 삭제되므로 항상 경고 후 진행. */}
      {deletingFolderId && (() => {
        const target = folders.find(f => f.id === deletingFolderId);
        if (!target) { setDeletingFolderId(null); return null; }
        const noteCount = notes.filter(n => n.folderId === deletingFolderId).length;
        return (
          <FolderDeleteConfirmModal
            folderName={target.name}
            noteCount={noteCount}
            onCancel={() => setDeletingFolderId(null)}
            onConfirm={() => {
              const id = deletingFolderId;
              setDeletingFolderId(null);
              confirmDeleteFolder(id);
            }}
          />
        );
      })()}
    </div>
  );
}

// 폴더 삭제 확인 모달 — 폴더와 내부 메모가 모두 지워짐을 경고하고, 삭제 대상 메모 수를 함께 표시.
// 스타일은 RepeatDeleteModal 과 통일(fixed inset overlay + 카드형 다이얼로그).
function FolderDeleteConfirmModal({
  folderName, noteCount, onCancel, onConfirm,
}: {
  folderName: string;
  noteCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-80 bg-card border border-border rounded-xl p-4 shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold mb-1">폴더 삭제</div>
        <div className="text-[11px] text-muted-foreground mb-3 truncate">"{folderName || "이름 없음"}"</div>
        <div className="text-xs text-foreground mb-4 leading-relaxed">
          {noteCount > 0
            ? <>이 폴더 안의 <span className="font-semibold text-destructive">메모 {noteCount}개</span>도 함께 삭제됩니다. 이 동작은 되돌릴 수 없습니다.</>
            : <>이 폴더를 삭제합니다. 폴더 안에 메모는 없습니다.</>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted transition-colors"
          >취소</button>
          <button
            onClick={onConfirm}
            className="flex-1 px-3 py-1.5 rounded-lg border border-destructive/40 text-xs hover:bg-destructive/10 text-destructive font-medium transition-colors"
          >삭제</button>
        </div>
      </div>
    </div>
  );
}

// 노트 리스트 안에 폴더를 카드로 노출. NoteCard와 시각 언어를 맞춰(rounded-xl, p-4, border)
// 같은 리스트에 섞여도 위화감이 없게 함. 드래그된 노트가 위에 오면 primary 링으로 강조하고,
// 클릭하면 폴더 안으로 진입. 우측 3-dot 메뉴로 이름·색상 편집이나 삭제.
// isEditing 상태에서는 카드 본문이 이름 입력 + 팔레트 폼으로 대체됨.
function FolderCard({
  folder, count, isDropTarget, isDragging, isEditing, paletteColors,
  onOpen, onStartEdit, onCancelEdit, onSaveEdit, onDelete,
  onAddPaletteColor, onRemovePaletteColor,
  onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
}: {
  folder: NoteFolder; count: number; isDropTarget: boolean; isDragging: boolean; isEditing: boolean;
  paletteColors: string[];
  onOpen: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (changes: { name?: string; color?: string }) => void;
  onDelete: () => void;
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(folder.name);
  const [colorDraft, setColorDraft] = useState(folder.color);
  const [showCustomColor, setShowCustomColor] = useState(false);

  // isEditing 이 새로 켜질 때 폼 필드를 현재 값으로 리셋(연속 편집 시 이전 draft 잔재 방지).
  useEffect(() => {
    if (isEditing) {
      setNameDraft(folder.name);
      setColorDraft(folder.color);
      setShowCustomColor(false);
    }
  }, [isEditing, folder.name, folder.color]);

  const commit = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    const changes: { name?: string; color?: string } = {};
    if (trimmed !== folder.name) changes.name = trimmed;
    if (colorDraft !== folder.color) changes.color = colorDraft;
    onSaveEdit(changes);
  };

  if (isEditing) {
    return (
      <div
        className="relative rounded-xl border bg-card p-4"
        style={{ borderColor: colorDraft + "55" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-shrink-0 flex items-center justify-center size-9 rounded-lg" style={{ backgroundColor: colorDraft + "22" }}>
            <Folder size={16} style={{ color: colorDraft }} fill={colorDraft} fillOpacity={0.35} />
          </div>
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") onCancelEdit(); }}
            placeholder="폴더 이름"
            className="flex-1 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
          />
          <button onClick={commit} disabled={!nameDraft.trim()} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40">저장</button>
          <button onClick={onCancelEdit} className="p-2 text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {paletteColors.map(c => (
            <div key={c} className="relative group/color size-6 flex-shrink-0">
              <button
                onClick={() => setColorDraft(c)}
                className={`size-6 rounded-full transition-transform ${colorDraft.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-2 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                style={{ backgroundColor: c }}
                title={c}
              />
              <button
                onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                className="absolute -top-1 -right-1 size-3.5 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                title="팔레트에서 제거"
              >
                <X size={8} strokeWidth={2.5} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setShowCustomColor(v => !v)}
            className={`size-6 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
            title="사용자 지정 색상 추가"
          >
            <Plus size={12} className={showCustomColor ? "text-primary" : "text-muted-foreground"} />
          </button>
        </div>
        {showCustomColor && (
          <div className="mt-2">
            <CustomColorPickerInline
              initial={colorDraft}
              onAdd={(c) => { setColorDraft(c); onAddPaletteColor(c); }}
              onClose={() => setShowCustomColor(false)}
            />
          </div>
        )}
        <div className="mt-3 pt-3 border-t border-border/60">
          <button
            onClick={() => { setMenuOpen(false); onDelete(); }}
            className="text-[11px] text-destructive hover:underline"
          >폴더 삭제</button>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group/folder relative flex items-center gap-3 p-4 rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer ${
        isDropTarget ? "border-primary bg-primary/10 ring-1 ring-primary" : ""
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <div className="flex-shrink-0 flex items-center justify-center size-9 rounded-lg" style={{ backgroundColor: folder.color + "22" }}>
        <Folder size={16} style={{ color: folder.color }} fill={folder.color} fillOpacity={0.35} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{folder.name}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{count}개 메모</div>
      </div>
      {/* 3-dot 메뉴 — 이름·색상 편집 / 삭제. 카드 클릭(폴더 진입)과 분리를 위해 stopPropagation. */}
      <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => setMenuOpen(v => !v)}
          title="폴더 옵션"
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-50 p-1">
              <button
                onClick={() => { setMenuOpen(false); onStartEdit(); }}
                className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors flex items-center gap-2"
              >
                <Edit3 size={12} /> 이름·색상 편집
              </button>
              <button
                onClick={() => { setMenuOpen(false); onDelete(); }}
                className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2"
              >
                <Trash2 size={12} /> 폴더 삭제
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note, folder, folders, menuOpen, onOpen, onToggleMenu, onMove, onDelete,
  onDragStart, onDragEnd, onDragOverCard, onDropCard,
}: {
  note: Note; folder: NoteFolder | null; folders: NoteFolder[]; menuOpen: boolean;
  onOpen: () => void; onToggleMenu: (e: React.MouseEvent) => void;
  onMove: (folderId: string | null) => void; onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void; onDragEnd: (e: React.DragEvent) => void;
  onDragOverCard: (e: React.DragEvent) => void; onDropCard: (e: React.DragEvent) => void;
}) {
  const preview = note.content.replace(/[#*`_>\-\[\]]/g, "").replace(/\n+/g, " ").trim();
  const dateStr = note.updatedAt ? note.updatedAt.slice(0, 10) : "";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onDrop={onDropCard}
      onClick={onOpen}
      className="group/note relative flex items-start gap-3 p-4 rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{note.title.trim() || "제목 없음"}</span>
          {note.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">{note.category}</span>}
        </div>
        {preview && <p className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{preview}</p>}
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
          {folder && <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ backgroundColor: folder.color }} />{folder.name}</span>}
          <span>{dateStr}</span>
        </div>
      </div>

      {/* 3-dot 메뉴 — 카드 전체 높이 기준 세로 중앙 */}
      <div className="relative flex-shrink-0 self-stretch flex items-center" onClick={e => e.stopPropagation()}>
        <button
          onClick={onToggleMenu}
          className="p-1 rounded-md text-muted-foreground hover:bg-muted opacity-0 group-hover/note:opacity-100 transition-opacity"
        ><MoreVertical size={15} /></button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-50 p-1">
            <div className="text-[10px] text-muted-foreground px-2.5 py-1">폴더로 이동</div>
            <button
              onClick={() => onMove(null)}
              className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors flex items-center gap-2 ${!note.folderId ? "text-primary" : ""}`}
            ><Folder size={12} /> 폴더 없음</button>
            {folders.map(f => (
              <button
                key={f.id}
                onClick={() => onMove(f.id)}
                className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors flex items-center gap-2 ${note.folderId === f.id ? "text-primary" : ""}`}
              ><span className="size-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: f.color }} /> {f.name}</button>
            ))}
            <div className="h-px bg-border my-1" />
            <button
              onClick={onDelete}
              className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2"
            ><Trash2 size={12} /> 삭제</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메모 편집기 뷰 (생성·수정 공용) ─────────────────────────────────
function NoteEditor({
  note, folders, allCategories, onBack, onChangeLocal,
}: {
  note: Note;
  folders: NoteFolder[];
  allCategories: string[];
  onBack: () => void;
  onChangeLocal: (patch: Partial<Note>) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [category, setCategory] = useState(note.category);
  const [folderId, setFolderId] = useState<string | null>(note.folderId);
  // 예전엔 "저장됨/저장 중…" 상태 텍스트를 노출했는데, 사용자 입장에선 완료했다는 명확한
  // 액션(버튼)이 있는 편이 더 안심됨. 자동 저장(debounce)은 안전망으로 유지하고 상단엔
  // 저장 버튼을 대신 배치 — 버튼을 누르면 pending debounce를 즉시 flush하고 목록으로 복귀.
  const [saving, setSaving] = useState(false);
  const first = useRef(true);
  // 아직 debounce 대기 중인 미저장 변경을 추적. 사용자가 debounce 안 끝난 상태에서
  // 뒤로가기를 누르면 아래 unmount cleanup이 이걸 즉시 flush해서 데이터 유실을 막음.
  // 예전엔 debounce cleanup(clearTimeout)만 있어서 마지막 몇 초 입력이 그대로 날아감.
  const pendingPatchRef = useRef<{ title: string; content: string; category: string; folderId: string | null } | null>(null);

  // 700ms debounce 자동 저장 (안전망). 상태 표시는 하지 않고, 성공/실패 결과는 저장 버튼과
  // 언마운트 flush에서만 사용자에게 보임.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const patch = { title, content, category, folderId };
    pendingPatchRef.current = patch;
    const t = setTimeout(async () => {
      try {
        await updateNote(note.id, patch);
        pendingPatchRef.current = null;
        onChangeLocal(patch);
      } catch (e) { notifyError("메모 저장 실패")(e); }
    }, 700);
    return () => clearTimeout(t);
  }, [title, content, category, folderId]);

  // 저장 버튼 — 대기 중인 debounce 패치를 즉시 flush + isDraft:false 로 확정하고 목록으로 복귀.
  // draft 노트는 임시 저장 탭에서만 보이므로, 저장 버튼을 눌러야 일반 리스트/폴더 뷰에 등장.
  // 자동 저장 debounce는 isDraft 필드를 건드리지 않으므로 뒤로가기(자동저장)만 하면 draft로 유지.
  const handleSave = async () => {
    setSaving(true);
    const savePatch = { ...(pendingPatchRef.current ?? {}), isDraft: false };
    try {
      await updateNote(note.id, savePatch);
      pendingPatchRef.current = null;
      onChangeLocal(savePatch);
    } catch (e) {
      setSaving(false);
      notifyError("메모 저장 실패")(e);
      return;
    }
    setSaving(false);
    onBack();
  };

  // 언마운트 시 아직 debounce 대기 중이던 변경을 즉시 저장. 뒤로가기 버튼으로 편집기를
  // 닫을 때 마지막 입력이 유실되지 않도록 하는 안전망.
  //
  // onChangeLocal은 부모 MemoSection이 매 렌더마다 새 함수로 만들어 내려주므로 deps에
  // 그대로 넣으면 부모가 다른 이유로 리렌더될 때마다 cleanup이 발화해 debounce 대기 중이던
  // 저장을 중복으로 트리거함. ref로 감싸서 최신 함수는 참조하되 effect는 재등록되지 않게.
  const onChangeLocalRef = useRef(onChangeLocal);
  onChangeLocalRef.current = onChangeLocal;
  useEffect(() => () => {
    const p = pendingPatchRef.current;
    if (p) {
      updateNote(note.id, p)
        .then(() => onChangeLocalRef.current(p))
        // 예전엔 console.error만 남겨서, 뒤로가기 순간 마지막 몇 초 입력이 저장 실패로
        // 조용히 사라져도 사용자가 알 수 없었음.
        .catch(notifyError("메모 저장 실패"));
    }
  }, [note.id]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* 상단 바 */}
      <div className="flex items-center gap-3 px-8 pt-8 pb-3 flex-shrink-0">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors" title="목록으로">
          <ArrowLeft size={18} />
        </button>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="제목 없음"
          className="flex-1 text-2xl font-medium bg-transparent outline-none placeholder:text-muted-foreground/50"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-60 transition-opacity flex-shrink-0"
        >
          <Check size={13} /> 저장
        </button>
      </div>

      {/* 메타: 카테고리 + 폴더 */}
      <div className="flex items-center gap-3 px-8 pb-3 flex-shrink-0">
        <input
          list="note-categories"
          value={category}
          onChange={e => setCategory(e.target.value)}
          placeholder="카테고리"
          className="px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring w-40"
        />
        <datalist id="note-categories">
          {allCategories.map(c => <option key={c} value={c} />)}
        </datalist>
        <select
          value={folderId ?? ""}
          onChange={e => setFolderId(e.target.value || null)}
          className="px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
        >
          <option value="">폴더 없음</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>

      {/* 편집 + 프리뷰 */}
      <div className="flex-1 overflow-hidden grid grid-cols-2 gap-4 px-8 pb-8 min-h-0">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="여기에 마크다운으로 자유롭게 적어보세요.&#10;&#10;# 제목&#10;- 목록&#10;- [ ] 체크박스&#10;**굵게**, *기울임*, `code`"
          className="w-full h-full resize-none rounded-xl border bg-card p-4 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring leading-relaxed"
          spellCheck={false}
          autoFocus
        />
        <div className={`w-full h-full overflow-y-auto rounded-xl border bg-card p-4 ${PROSE_CLASS}`}>
          {content.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          ) : (
            <p className="text-muted-foreground text-sm italic">미리보기가 여기에 표시돼요</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Settings Section ───────────────────────────────────────────────
function SettingsSection({
  pomodoroOn, setPomodoroOn, pomWork, setPomWork,
  pomBreak, setPomBreak, abandonOn, setAbandonOn, abandonMin, setAbandonMin,
  darkMode, setDarkMode,
  fontSize, setFontSize,
}: {
  pomodoroOn: boolean; setPomodoroOn: (v: boolean) => void;
  pomWork: number; setPomWork: (v: number) => void;
  pomBreak: number; setPomBreak: (v: number) => void;
  abandonOn: boolean; setAbandonOn: (v: boolean) => void;
  abandonMin: number; setAbandonMin: (v: number) => void;
  darkMode: boolean; setDarkMode: (v: boolean) => void;
  fontSize: "normal" | "larger" | "large"; setFontSize: (v: "normal" | "larger" | "large") => void;
}) {
  // 데이터 백업/업데이트 상태 — JSON export/import UI는 개인용에서 직관적이지 않아 제거,
  // 데이터 이전이 필요할 때는 %APPDATA%/…/backups 폴더의 .db 파일을 직접 복사하면 됨.
  // 두 버튼의 busy 상태를 분리 — 하나 누르면 둘 다 disabled:opacity-50 로 깜빡이던 버그 방지.
  // 추가로 ref 기반 재진입 가드 — React 재렌더 전에 클릭 이벤트가 중첩되어 setState가
  // 반영되기 전 동일 핸들러가 두 번 실행되는 경우까지 막음.
  type Target = "backup" | "update";
  const [backupBusy, setBackupBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const backupBusyRef = useRef(false);
  const updateBusyRef = useRef(false);
  // 상태 토스트를 각 버튼 옆에 인라인 표시 — target으로 어느 버튼에 붙일지 지정.
  const [statusMsg, setStatusMsg] = useState<{ kind: "ok" | "err"; text: string; target: Target } | null>(null);
  const [statusVisible, setStatusVisible] = useState(false);
  const flashTimersRef = useRef<number[]>([]);
  const [lastBackupTs, setLastBackupTs] = useState<number | null>(getLastBackupTimestamp());
  // 사용 가능한 업데이트가 있을 때 확인 카드를 인라인으로 표시 — 예전엔 window.confirm으로
  // OS-native 다이얼로그를 띄웠지만 앱 톤과 어울리지 않고 OS/WebView에 따라 룩앤필이 달라짐.
  const [pendingUpdate, setPendingUpdate] = useState<
    Extract<UpdateCheckResult, { status: "available" }> | null
  >(null);
  const [installing, setInstalling] = useState(false);
  const flash = (target: Target, kind: "ok" | "err", text: string) => {
    flashTimersRef.current.forEach(t => window.clearTimeout(t));
    flashTimersRef.current = [];
    setStatusMsg({ kind, text, target });
    setStatusVisible(false);
    // 순서: mount(opacity-0) → 다음 페인트 프레임 뒤 opacity 0→1 (fade in 500ms) → 1s 유지 → opacity 1→0 (fade out 500ms) → unmount.
    // requestAnimationFrame을 두 번 감싸서 React 커밋 + 브라우저 첫 페인트가 완전히 끝난 뒤에
    // opacity 클래스를 바꾸도록 보장 — 안 그러면 브라우저가 opacity-0을 안 그리고 바로 opacity-100으로 뛰어 트랜지션이 안 걸리는 케이스가 있음.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setStatusVisible(true));
    });
    flashTimersRef.current.push(window.setTimeout(() => setStatusVisible(false), 1550));
    flashTimersRef.current.push(window.setTimeout(() => setStatusMsg(null), 2100));
  };
  useEffect(() => () => { flashTimersRef.current.forEach(t => window.clearTimeout(t)); }, []);

  const handleBackupNow = async () => {
    if (backupBusyRef.current) return;
    backupBusyRef.current = true;
    setBackupBusy(true);
    try {
      await createBackupNow();
      setLastBackupTs(getLastBackupTimestamp());
      flash("backup", "ok", "백업 성공");
    } catch (e: any) {
      flash("backup", "err", `백업 실패: ${e?.message ?? e}`);
    } finally {
      setBackupBusy(false);
      backupBusyRef.current = false;
    }
  };
  const handleUpdateCheck = async () => {
    if (updateBusyRef.current) return;
    updateBusyRef.current = true;
    setUpdateBusy(true);
    try {
      const r = await checkForUpdate();
      if (r.status === "up-to-date") {
        flash("update", "ok", "이미 최신 버전입니다.");
      } else if (r.status === "available") {
        // 인라인 확인 카드로 전환 — 사용자가 "설치"를 눌러야 실제 다운로드+재시작이 시작됨.
        setPendingUpdate(r);
      } else {
        flash("update", "err", `업데이트 확인 실패: ${r.error}`);
      }
    } catch (e: any) {
      flash("update", "err", `업데이트 확인 실패: ${e?.message ?? e}`);
    } finally {
      setUpdateBusy(false);
      updateBusyRef.current = false;
    }
  };
  const handleInstallUpdate = async () => {
    if (!pendingUpdate || installing) return;
    setInstalling(true);
    try {
      await installUpdate(pendingUpdate.update);
      // installUpdate 안에서 relaunch()가 실행되므로 정상 흐름에선 여기 도달 전에 앱이 재시작됨.
    } catch (e: any) {
      flash("update", "err", `설치 실패: ${e?.message ?? e}`);
      setInstalling(false);
      setPendingUpdate(null);
    }
  };

  const lastBackupLabel = lastBackupTs
    ? new Date(lastBackupTs).toLocaleDateString("ko-KR", { dateStyle: "medium" })
    : "없음";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-8 pt-16 pb-8">
        <div className="space-y-4">
          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">다크 모드</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">어두운 색상 테마 사용</div>
              </div>
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${darkMode ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${darkMode ? "left-5" : "left-1"}`} />
              </button>
            </div>
          </div>

          {/* 글씨 크기 — zoom으로 앱 전체 배율을 조정. "보통"이 기본(현재 크기). */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="mb-3">
              <div className="text-sm font-medium">글씨 크기</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">앱 전체 표시 배율</div>
            </div>
            <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5">
              {([
                { v: "normal" as const, label: "보통" },
                { v: "larger" as const, label: "살짝 크게" },
                { v: "large" as const, label: "크게" },
              ]).map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => setFontSize(v)}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-all ${
                    fontSize === v ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">뽀모도로 모드</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">전역 타이머에 뽀모도로 사이클 적용</div>
              </div>
              <button
                onClick={() => setPomodoroOn(!pomodoroOn)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${pomodoroOn ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${pomodoroOn ? "left-5" : "left-1"}`} />
              </button>
            </div>
            {pomodoroOn && (
              <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-border">
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1.5">공부 시간 (분)</label>
                  <input type="number" min={1} value={pomWork} onChange={e => setPomWork(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1.5">쉬는 시간 (분)</label>
                  <input type="number" min={1} value={pomBreak} onChange={e => setPomBreak(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">방치 알림</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">수동 정지 후 지정 시간이 지나면 브라우저 알림 발송</div>
              </div>
              <button
                onClick={() => setAbandonOn(!abandonOn)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${abandonOn ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${abandonOn ? "left-5" : "left-1"}`} />
              </button>
            </div>
            {abandonOn && (
              <div className="mt-4 pt-4 border-t border-border">
                <label className="block text-[11px] text-muted-foreground mb-1.5">알림 임계 시간 (분)</label>
                <input type="number" min={1} value={abandonMin} onChange={e => setAbandonMin(Math.max(1, Number(e.target.value) || 1))}
                  className="w-40 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">데이터 백업</div>
            <div className="text-[11px] text-muted-foreground mb-3">
              하루 1회 자동 백업 · 마지막 백업: <span className="text-foreground">{lastBackupLabel}</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleBackupNow}
                disabled={backupBusy}
                className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >{backupBusy ? "백업 중…" : "지금 백업"}</button>
              {statusMsg?.target === "backup" && (
                <span className={`min-w-0 text-[11px] leading-snug transition-opacity duration-500 ease-out ${statusVisible ? "opacity-100" : "opacity-0"} ${statusMsg.kind === "ok" ? "text-primary" : "text-destructive"}`}>
                  {statusMsg.text}
                </span>
              )}
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">앱 업데이트</div>
            <div className="text-[11px] text-muted-foreground mb-3">
              최신 릴리스를 확인하고 설치. 서명된 패키지만 적용되며 설치 후 앱이 재시작됩니다.
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleUpdateCheck}
                disabled={updateBusy || installing || !!pendingUpdate}
                className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >{updateBusy ? "확인 중…" : "업데이트 확인"}</button>
              {statusMsg?.target === "update" && !pendingUpdate && (
                <span className={`min-w-0 text-[11px] leading-snug transition-opacity duration-500 ease-out ${statusVisible ? "opacity-100" : "opacity-0"} ${statusMsg.kind === "ok" ? "text-primary" : "text-destructive"}`}>
                  {statusMsg.text}
                </span>
              )}
            </div>
            {pendingUpdate && (
              <div className="mt-3 pt-3 border-t border-border space-y-2">
                <div className="text-xs">
                  <span className="text-muted-foreground">새 버전</span>{" "}
                  <span className="font-medium">v{pendingUpdate.next}</span>
                  {pendingUpdate.current && (
                    <span className="text-muted-foreground"> (현재 v{pendingUpdate.current})</span>
                  )}
                </div>
                {pendingUpdate.notes && (
                  <div className="text-[11px] text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto rounded-md bg-muted/40 p-2">
                    {pendingUpdate.notes}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleInstallUpdate}
                    disabled={installing}
                    className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
                  >{installing ? "설치 중…" : "지금 설치 후 재시작"}</button>
                  <button
                    onClick={() => setPendingUpdate(null)}
                    disabled={installing}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-muted hover:bg-muted/70 text-foreground disabled:opacity-50 transition-colors"
                  >나중에</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Block Detail Panel — no timer (v3, todo 상세와 동일 레이아웃) ────────
// 색상 팔레트/태그/하위 타임블록/반복 설정/습관 스태킹을 모두 걷어내고
// 상세 패널 "반복" 섹션 — 계획 시간(블록)/날짜(할 일) 아래에 위치. 현재 규칙 요약을 보여주고,
// 펼치면 주기(매일/매주/매달/매년)/요일/종료 인라인 폼으로 규칙을 (재)설정한다. 블록·할 일 공용.
function RepeatSection({ originDate, repeat, hasGroup, onSetRepeat }: {
  originDate: string;
  repeat?: BlockRepeat;
  hasGroup?: boolean;
  onSetRepeat: (r: BlockRepeat) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"daily" | "weekly" | "monthly" | "yearly">(repeat?.type ?? "daily");
  const [days, setDays] = useState<number[]>(repeat?.days ?? []);
  const [endType, setEndType] = useState<"none" | "count" | "date">(repeat?.endType ?? "none");
  const [endCount, setEndCount] = useState(repeat?.endCount ?? 10);
  const [endDate, setEndDate] = useState(repeat?.endDate ?? "");
  const toggleDay = (d: number) => setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort());
  const canApply = type !== "weekly" || days.length > 0;
  const origin = parseLocalDate(originDate);
  const typeLabel = (r: BlockRepeat) =>
    r.type === "daily" ? "매일"
      : r.type === "weekly" ? `매주 ${r.days.map(d => DAYS_KO[d]).join("·")}`
      : r.type === "monthly" ? `매달 ${origin.getDate()}일`
      : `매년 ${origin.getMonth() + 1}월 ${origin.getDate()}일`;
  const summary = repeat
    ? `${typeLabel(repeat)}${
        repeat.endType === "count" ? ` · ${repeat.endCount}회`
        : repeat.endType === "date" ? ` · ${repeat.endDate}까지` : ""}`
    : "반복 없음";
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground mb-1.5">반복</div>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/70 transition-colors text-left"
      >
        <span className={`flex-1 text-xs truncate ${repeat ? "text-foreground" : "text-muted-foreground"}`}>
          {hasGroup && "↻ "}{summary}
        </span>
        <ChevronDown size={12} className={`text-muted-foreground flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 p-2.5 rounded-lg border border-border space-y-3">
          <div>
            <div className="text-[11px] text-muted-foreground mb-1.5">반복 주기</div>
            <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5">
              {([["daily", "매일"], ["weekly", "매주"], ["monthly", "매달"], ["yearly", "매년"]] as const).map(([v, label]) => (
                <button key={v} onClick={() => setType(v)}
                  className={`flex-1 px-1 py-1.5 text-[11px] rounded-md transition-all ${type === v ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {type === "weekly" && (
            <div>
              <div className="text-[11px] text-muted-foreground mb-1.5">요일</div>
              <div className="flex gap-1">
                {DAYS_KO.map((label, i) => (
                  <button key={i} onClick={() => toggleDay(i)}
                    className={`flex-1 py-1.5 text-[11px] rounded-md border transition-colors ${days.includes(i) ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] text-muted-foreground mb-1.5">종료</div>
            <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5 mb-2">
              {([{ v: "none", label: "제한 없음" }, { v: "count", label: "N회" }, { v: "date", label: "날짜까지" }] as const).map(o => (
                <button key={o.v} onClick={() => setEndType(o.v)}
                  className={`flex-1 px-2 py-1.5 text-[11px] rounded-md transition-all ${endType === o.v ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {endType === "count" && (
              <input type="number" min={1} value={endCount} onChange={e => setEndCount(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring" />
            )}
            {endType === "date" && (
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring" />
            )}
          </div>
          <button
            onClick={() => { onSetRepeat({ type, days, endType, endCount, endDate }); setOpen(false); }}
            disabled={!canApply || (endType === "date" && !endDate)}
            className="w-full px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >적용</button>
        </div>
      )}
    </div>
  );
}

// TodoDetailPanel 과 같은 순서/구성으로 통일. 블록에만 있는 항목은 "계획 시간"
// 하나뿐이며, 그 외 오늘 달성률·완료·카테고리·메모·체크리스트·삭제는 동일 UI/UX.
function BlockDetailPanel({
  block, templates, initialEditTitle, paletteColors,
  onClose, onToggle, onDelete, onTitleSave, onMemoSave, onCategorySave, onCountInCompletionSave, onAddTemplate, onSetRepeat,
}: {
  block: Block;
  templates: Template[];
  initialEditTitle?: boolean;
  paletteColors: string[];
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onTitleSave: (title: string) => void;
  onMemoSave: (memo: string) => void;
  onCategorySave: (category: string) => void;
  onCountInCompletionSave: (v: boolean) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[]; kind?: "time" | "todo" }) => void;
  // 반복 규칙 적용 — setBlockRepeat 으로 반복 그룹을 (재)생성.
  onSetRepeat: (repeat: BlockRepeat) => void;
}) {
  const [memo, setMemo] = useState(block.memo);
  const [category, setCategory] = useState(block.category);
  // 헤더 제목 인라인 편집 — 캘린더 직접 생성 블록은 initialEditTitle=true로 넘어와서
  // 패널이 뜨자마자 편집 모드로 진입하고 input에 포커스가 잡힘.
  const [editingTitle, setEditingTitle] = useState(!!initialEditTitle);
  const [titleDraft, setTitleDraft] = useState(block.title);
  // 카테고리 드롭다운 열림 여부 · 새 카테고리 인라인 폼 상태 — todo 상세와 동일 로직.
  const [catOpen, setCatOpen] = useState(false);
  const [newCatMode, setNewCatMode] = useState(false);
  const [newCatTitle, setNewCatTitle] = useState("");
  const [newCatColor, setNewCatColor] = useState<string>(paletteColors[0] ?? "#5AA9E6");
  const catDropdownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!catOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (catDropdownRef.current && !catDropdownRef.current.contains(e.target as Node)) {
        setCatOpen(false); setNewCatMode(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCatOpen(false); setNewCatMode(false); }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [catOpen]);
  const categories = templates.filter(t => t.kind === "todo");
  const color = getCategoryColor(templates, category);
  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== block.title) onTitleSave(trimmed);
    else setTitleDraft(block.title);
    setEditingTitle(false);
  };
  const chooseCategory = (name: string) => {
    setCategory(name);
    if (name !== block.category) onCategorySave(name);
    setCatOpen(false); setNewCatMode(false);
  };
  const commitNewCategory = () => {
    const name = newCatTitle.trim();
    if (!name) return;
    const existing = categories.find(c => c.title === name);
    if (!existing) onAddTemplate({ title: name, color: newCatColor, tags: [], kind: "todo" });
    setNewCatTitle(""); setNewCatMode(false);
    chooseCategory(name);
  };

  // 체크리스트 — 이 블록에 소속된 항목만 불러와 관리. 상세 패널이 블록별로 리마운트되므로 로컬 상태.
  const [items, setItems] = useState<ChecklistItemT[]>([]);
  useEffect(() => {
    fetchChecklistItems(block.id).then(setItems).catch(notifyError("체크리스트 불러오기 실패"));
  }, [block.id]);
  const addChecklistItem = async (text: string, parentItemId?: string) => {
    try {
      const created = await createChecklistItem(block.id, text, parentItemId);
      setItems(is => [...is, created]);
    } catch (e) { notifyError("체크리스트 항목 추가 실패")(e); }
  };
  const toggleChecklistItem = async (id: string, completed: boolean) => {
    setItems(is => is.map(i => i.id === id ? { ...i, completed } : i));
    try { await toggleChecklistItemRow(id, completed); }
    catch (e) { notifyError("체크리스트 저장 실패")(e); }
  };
  const deleteChecklistItem = async (id: string) => {
    // DB의 FK가 ON DELETE CASCADE라 하위 항목도 서버에서 같이 지워짐 — 로컬 상태도 함께 정리.
    const snapshot = items;
    const toRemove = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of snapshot) {
        if (it.parentItemId && toRemove.has(it.parentItemId) && !toRemove.has(it.id)) {
          toRemove.add(it.id); grew = true;
        }
      }
    }
    setItems(is => is.filter(i => !toRemove.has(i.id)));
    try { await deleteChecklistItemRow(id); }
    catch (e) { notifyError("체크리스트 삭제 실패")(e); }
  };

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border flex-shrink-0">
        <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { setTitleDraft(block.title); setEditingTitle(false); }
            }}
            className="flex-1 min-w-0 text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5"
          />
        ) : (
          <button
            onClick={() => { setTitleDraft(block.title); setEditingTitle(true); }}
            title="제목 편집"
            className="flex-1 min-w-0 text-left text-sm font-medium truncate hover:bg-muted/40 rounded px-1 py-0.5 transition-colors"
          >{block.title}</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* 카테고리 — 제목 바로 아래 (todo 와 동일한 드롭다운). */}
        <div className="relative">
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">카테고리</div>
          <button
            onClick={() => { setCatOpen(v => !v); setNewCatMode(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/70 transition-colors text-left"
          >
            <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
            <span className={`flex-1 text-xs truncate ${category ? "text-foreground" : "text-muted-foreground"}`}>
              {category || "미분류"}
            </span>
            <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" />
          </button>
          {catOpen && (
            <div
              ref={catDropdownRef}
              className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-border bg-card shadow-lg p-1 space-y-0.5 max-h-72 overflow-y-auto"
            >
              {categories.map(c => (
                <button
                  key={c.id}
                  onClick={() => chooseCategory(c.title)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left ${c.title === category ? "bg-muted/60" : ""}`}
                >
                  <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: c.color }} />
                  <span className="text-xs truncate">{c.title}</span>
                  {c.title === category && <Check size={11} className="text-primary flex-shrink-0" />}
                </button>
              ))}
              {categories.length === 0 && (
                <div className="text-[10px] text-muted-foreground px-2 py-1.5">아직 카테고리가 없습니다</div>
              )}
              <button
                onClick={() => chooseCategory("")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left ${!category ? "bg-muted/60" : ""}`}
              >
                <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: UNCATEGORIZED_TODO_COLOR }} />
                <span className="text-xs text-muted-foreground truncate">미분류</span>
                {!category && <Check size={11} className="text-primary flex-shrink-0" />}
              </button>
              <div className="h-px bg-border/60 my-0.5" />
              {newCatMode ? (
                <div className="p-1.5 space-y-1.5">
                  <input
                    autoFocus
                    value={newCatTitle}
                    onChange={e => setNewCatTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); commitNewCategory(); }
                      else if (e.key === "Escape") { e.preventDefault(); setNewCatMode(false); setNewCatTitle(""); }
                    }}
                    placeholder="카테고리 이름..."
                    className="w-full text-xs px-2 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex flex-wrap gap-1">
                    {paletteColors.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewCatColor(c)}
                        className={`size-4 rounded-full transition-transform ${newCatColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={commitNewCategory}
                      disabled={!newCatTitle.trim()}
                      className="flex-1 text-[11px] py-1 rounded bg-primary text-primary-foreground disabled:opacity-40"
                    >추가</button>
                    <button
                      onClick={() => { setNewCatMode(false); setNewCatTitle(""); }}
                      className="flex-1 text-[11px] py-1 rounded bg-muted hover:bg-muted/70"
                    >취소</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setNewCatMode(true)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left"
                >
                  <Plus size={11} className="text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">새 카테고리</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 오늘 달성률 포함 (todo 와 동일). */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={block.countInCompletion !== false}
            onChange={e => onCountInCompletionSave(e.target.checked)}
            className="size-3.5 rounded border-border accent-primary cursor-pointer"
          />
          <span className="text-[11px] text-foreground">오늘 달성률에 포함</span>
        </label>

        {/* 계획 시간 — 블록 전용. todo 상세에는 "날짜" 카드가 이 자리에 옴. */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">계획 시간</div>
          <div className="px-3 py-2.5 rounded-lg bg-muted/40 border border-border">
            <div className="text-[11px] text-muted-foreground">
              {block.date} ({DAYS_KO[parseLocalDate(block.date).getDay()]})
            </div>
            <div className="text-sm font-medium mt-0.5">
              {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{durMin(block)}분</div>
          </div>
        </div>

        {/* 반복 — 계획 시간 바로 아래. 현재 규칙 요약 + 인라인 설정 폼. */}
        <RepeatSection originDate={block.date} repeat={block.repeat} hasGroup={!!block.repeatGroupId} onSetRepeat={onSetRepeat} />

        {/* Memo */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">메모</div>
          <textarea
            value={memo}
            onChange={e => setMemo(e.target.value)}
            onBlur={() => { if (memo !== block.memo) onMemoSave(memo); }}
            placeholder="자유롭게 메모하세요..."
            className="w-full h-24 px-3 py-2 text-xs bg-muted rounded-lg resize-none outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* 체크리스트 — 블록 바로 아래 단계만 추가 가능. todo 상세와 동일한 ChecklistNode 컴포넌트. */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-2">체크리스트</div>
          <div className="space-y-0.5">
            {items.filter(i => !i.parentItemId).map(item => (
              <ChecklistNode
                key={item.id}
                item={item}
                items={items}
                depth={0}
                onToggle={toggleChecklistItem}
                onDelete={deleteChecklistItem}
              />
            ))}
            <NewChecklistItemForm onAdd={text => addChecklistItem(text)} />
          </div>
        </div>

        {/* 완료 토글 — 삭제 버튼 바로 위. 달성률에 포함되지 않는 블록은 완료 개념이 없으므로 숨김. */}
        {block.countInCompletion !== false && (
          <button
            onClick={onToggle}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors ${
              block.completed ? "bg-muted/40 border-transparent" : "bg-card border-border hover:border-primary/40"
            }`}
          >
            {block.completed
              ? <CheckCircle2 size={16} style={{ color }} />
              : <Circle size={16} className="text-muted-foreground" />}
            <span className={`text-xs ${block.completed ? "text-muted-foreground line-through" : ""}`}>
              {block.completed ? "완료됨 — 다시 열기" : "완료 처리"}
            </span>
          </button>
        )}

        {/* 삭제 */}
        <button
          onClick={() => { onDelete(); onClose(); }}
          className="w-full text-[11px] text-destructive hover:bg-destructive/10 rounded-lg py-2 transition-colors"
        >
          블록 삭제
        </button>

        {/* 저장/닫기 — 필드는 변경 즉시 저장되므로 둘 다 패널을 닫음. 저장이 주 버튼. */}
        <div className="space-y-1.5">
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
          >저장</button>
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted transition-colors"
          >닫기</button>
        </div>
      </div>
    </div>
  );
}

// ── Checklist item — recursive, unlimited nesting ─────────────────
// Block 과 Todo 양쪽 체크리스트를 동일한 컴포넌트로 렌더링. 최소 필드만 요구.
type ChecklistNodeItem = { id: string; parentItemId?: string; text: string; completed: boolean };
// 새 항목은 블록 바로 아래(depth 0) 로만 추가됨 — 하위 항목 추가 UI 는 제거됨.
// 기존 데이터에 남아 있는 중첩 항목은 그대로 표시(호환), 다만 더 깊이 파고들 수는 없음.
function ChecklistNode({
  item, items, depth, onToggle, onDelete,
}: {
  item: ChecklistNodeItem;
  items: ChecklistNodeItem[];
  depth: number;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const kids = items.filter(i => i.parentItemId === item.id);

  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <div className="group flex items-center gap-1.5 text-xs py-0.5">
        <button onClick={() => onToggle(item.id, !item.completed)} className="flex-shrink-0">
          {item.completed
            ? <CheckCircle2 size={13} className="text-sky-500" />
            : <Circle size={13} className="text-muted-foreground" />
          }
        </button>
        <span className={`flex-1 min-w-0 truncate ${item.completed ? "line-through text-muted-foreground" : ""}`}>{item.text}</span>
        <button
          onClick={() => onDelete(item.id)}
          title="삭제"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity flex-shrink-0"
        >
          <X size={11} />
        </button>
      </div>
      {kids.map(k => (
        <ChecklistNode key={k.id} item={k} items={items} depth={depth + 1} onToggle={onToggle} onDelete={onDelete} />
      ))}
    </div>
  );
}

function NewChecklistItemForm({
  onAdd, onCancel, autoFocus,
}: {
  onAdd: (text: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (text.trim()) { onAdd(text.trim()); setText(""); } }}
      className="flex items-center gap-1.5 mt-1"
    >
      <input
        autoFocus={autoFocus}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") onCancel?.(); }}
        placeholder="항목 추가..."
        className="flex-1 text-xs px-2 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
      />
      {text && (
        <button type="submit" className="text-[11px] text-sky-600 hover:text-sky-700 px-1.5">추가</button>
      )}
    </form>
  );
}

// ── Todo detail side panel ─────────────────────────────────────────
// 시간 블록의 BlockDetailPanel 과 같은 자리에 뜨는 라이트 버전. 시간 블록에 있는
// 반복/자식 블록/습관 스태킹/체크리스트 같은 기능은 없이 제목·카테고리·메모·완료·삭제만.
// 색상은 카테고리에서 자동 상속하므로 팔레트 UI 는 없음.
function TodoDetailPanel({
  todo, templates, initialEditTitle, paletteColors, checklistItems,
  onClose, onToggle, onDelete, onTitleSave, onMemoSave, onCategorySave, onCountInCompletionSave, onAddTemplate, onSetRepeat,
  onAddChecklistItem, onToggleChecklistItem, onDeleteChecklistItem,
}: {
  todo: Todo;
  templates: Template[];
  // 캘린더에서 방금 만들어진 할 일이면 상세 패널이 열리자마자 제목 편집 모드로 시작.
  initialEditTitle?: boolean;
  paletteColors: string[];
  // 이 todo 에 소속된 체크리스트 항목만 걸러 넘겨줌. 컴포넌트 내부에서 CRUD 는 콜백으로.
  checklistItems: TodoChecklistItemT[];
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onTitleSave: (title: string) => void;
  onMemoSave: (memo: string) => void;
  onCategorySave: (category: string) => void;
  onCountInCompletionSave: (v: boolean) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[]; kind?: "time" | "todo" }) => void;
  // 반복 규칙 적용 — setTodoRepeat 으로 반복 그룹을 (재)생성.
  onSetRepeat: (repeat: BlockRepeat) => void;
  onAddChecklistItem: (text: string, parentItemId?: string) => void;
  onToggleChecklistItem: (id: string, completed: boolean) => void;
  onDeleteChecklistItem: (id: string) => void;
}) {
  const [memo, setMemo] = useState(todo.memo);
  const [category, setCategory] = useState(todo.category);
  const [editingTitle, setEditingTitle] = useState(!!initialEditTitle);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  // 카테고리 드롭다운 열림 여부 · 새 카테고리 인라인 폼 상태.
  const [catOpen, setCatOpen] = useState(false);
  const [newCatMode, setNewCatMode] = useState(false);
  const [newCatTitle, setNewCatTitle] = useState("");
  const [newCatColor, setNewCatColor] = useState<string>(paletteColors[0] ?? "#5AA9E6");
  const catDropdownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!catOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (catDropdownRef.current && !catDropdownRef.current.contains(e.target as Node)) {
        setCatOpen(false); setNewCatMode(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCatOpen(false); setNewCatMode(false); }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [catOpen]);
  const categories = templates.filter(t => t.kind === "todo");
  const color = getCategoryColor(templates, category);
  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== todo.title) onTitleSave(trimmed);
    else setTitleDraft(todo.title);
    setEditingTitle(false);
  };
  const chooseCategory = (name: string) => {
    setCategory(name);
    if (name !== todo.category) onCategorySave(name);
    setCatOpen(false); setNewCatMode(false);
  };
  const commitNewCategory = () => {
    const name = newCatTitle.trim();
    if (!name) return;
    const existing = categories.find(c => c.title === name);
    if (!existing) onAddTemplate({ title: name, color: newCatColor, tags: [], kind: "todo" });
    setNewCatTitle(""); setNewCatMode(false);
    chooseCategory(name);
  };

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border flex-shrink-0">
        <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { setTitleDraft(todo.title); setEditingTitle(false); }
            }}
            className="flex-1 min-w-0 text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5"
          />
        ) : (
          <button
            onClick={() => { setTitleDraft(todo.title); setEditingTitle(true); }}
            title="제목 편집"
            className="flex-1 min-w-0 text-left text-sm font-medium truncate hover:bg-muted/40 rounded px-1 py-0.5 transition-colors"
          >
            {todo.title}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* 카테고리 — 제목 바로 아래. 기존 목록에서 선택하거나 이 자리에서 새로 만들기.
             할 일 색상은 선택한 카테고리 색을 자동 상속하므로 색상 편집 UI 는 없음. */}
        <div className="relative">
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">카테고리</div>
          <button
            onClick={() => { setCatOpen(v => !v); setNewCatMode(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/70 transition-colors text-left"
          >
            <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
            <span className={`flex-1 text-xs truncate ${category ? "text-foreground" : "text-muted-foreground"}`}>
              {category || "미분류"}
            </span>
            <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" />
          </button>
          {catOpen && (
            <div
              ref={catDropdownRef}
              className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-border bg-card shadow-lg p-1 space-y-0.5 max-h-72 overflow-y-auto"
            >
              {categories.map(c => (
                <button
                  key={c.id}
                  onClick={() => chooseCategory(c.title)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left ${c.title === category ? "bg-muted/60" : ""}`}
                >
                  <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: c.color }} />
                  <span className="text-xs truncate">{c.title}</span>
                  {c.title === category && <Check size={11} className="text-primary flex-shrink-0" />}
                </button>
              ))}
              {categories.length === 0 && (
                <div className="text-[10px] text-muted-foreground px-2 py-1.5">아직 카테고리가 없습니다</div>
              )}
              <button
                onClick={() => chooseCategory("")}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left ${!category ? "bg-muted/60" : ""}`}
              >
                <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: UNCATEGORIZED_TODO_COLOR }} />
                <span className="text-xs text-muted-foreground truncate">미분류</span>
                {!category && <Check size={11} className="text-primary flex-shrink-0" />}
              </button>
              <div className="h-px bg-border/60 my-0.5" />
              {newCatMode ? (
                <div className="p-1.5 space-y-1.5">
                  <input
                    autoFocus
                    value={newCatTitle}
                    onChange={e => setNewCatTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); commitNewCategory(); }
                      else if (e.key === "Escape") { e.preventDefault(); setNewCatMode(false); setNewCatTitle(""); }
                    }}
                    placeholder="카테고리 이름..."
                    className="w-full text-xs px-2 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex flex-wrap gap-1">
                    {paletteColors.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewCatColor(c)}
                        className={`size-4 rounded-full transition-transform ${newCatColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={commitNewCategory}
                      disabled={!newCatTitle.trim()}
                      className="flex-1 text-[11px] py-1 rounded bg-primary text-primary-foreground disabled:opacity-40"
                    >추가</button>
                    <button
                      onClick={() => { setNewCatMode(false); setNewCatTitle(""); }}
                      className="flex-1 text-[11px] py-1 rounded bg-muted hover:bg-muted/70"
                    >취소</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setNewCatMode(true)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left"
                >
                  <Plus size={11} className="text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">새 카테고리</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 오늘 달성률 포함 여부 토글 — 시간 블록과 동일한 옵션. */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={todo.countInCompletion !== false}
            onChange={e => onCountInCompletionSave(e.target.checked)}
            className="size-3.5 rounded border-border accent-primary cursor-pointer"
          />
          <span className="text-[11px] text-foreground">오늘 달성률에 포함</span>
        </label>

        {/* 날짜 */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">날짜</div>
          <div className="px-3 py-2.5 rounded-lg bg-muted/40 border border-border">
            <div className="text-sm font-medium">
              {todo.date} ({DAYS_KO[parseLocalDate(todo.date).getDay()]})
              {todo.endDate && todo.endDate !== todo.date && (
                <span className="text-muted-foreground"> ~ {todo.endDate}</span>
              )}
            </div>
          </div>
        </div>

        {/* 반복 — 날짜 바로 아래. 시간 블록과 동일한 규칙/폼(RepeatSection 공용). */}
        <RepeatSection originDate={todo.date} repeat={todo.repeat} hasGroup={!!todo.repeatGroupId} onSetRepeat={onSetRepeat} />

        {/* Memo */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">메모</div>
          <textarea
            value={memo}
            onChange={e => setMemo(e.target.value)}
            onBlur={() => { if (memo !== todo.memo) onMemoSave(memo); }}
            placeholder="자유롭게 메모하세요..."
            className="w-full h-24 px-3 py-2 text-xs bg-muted rounded-lg resize-none outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* 체크리스트 — 블록 바로 아래 단계만 추가 가능. 블록의 체크리스트와 동일한 ChecklistNode 컴포넌트. */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-2">체크리스트</div>
          <div className="space-y-0.5">
            {checklistItems.filter(i => !i.parentItemId).map(item => (
              <ChecklistNode
                key={item.id}
                item={item}
                items={checklistItems}
                depth={0}
                onToggle={onToggleChecklistItem}
                onDelete={onDeleteChecklistItem}
              />
            ))}
            <NewChecklistItemForm onAdd={text => onAddChecklistItem(text)} />
          </div>
        </div>

        {/* 완료 토글 — 삭제 버튼 바로 위. 달성률에 포함되지 않는 할 일은 완료 개념이 없으므로 숨김. */}
        {todo.countInCompletion !== false && (
          <button
            onClick={onToggle}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors ${
              todo.completed ? "bg-muted/40 border-transparent" : "bg-card border-border hover:border-primary/40"
            }`}
          >
            {todo.completed
              ? <CheckCircle2 size={16} style={{ color }} />
              : <Circle size={16} className="text-muted-foreground" />}
            <span className={`text-xs ${todo.completed ? "text-muted-foreground line-through" : ""}`}>
              {todo.completed ? "완료됨 — 다시 열기" : "완료 처리"}
            </span>
          </button>
        )}

        {/* Delete */}
        <button
          onClick={() => { onDelete(); onClose(); }}
          className="w-full text-[11px] text-destructive hover:bg-destructive/10 rounded-lg py-2 transition-colors"
        >
          할 일 삭제
        </button>

        {/* 저장/닫기 — 필드는 변경 즉시 저장되므로 둘 다 패널을 닫음. 저장이 주 버튼. */}
        <div className="space-y-1.5">
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
          >저장</button>
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted transition-colors"
          >닫기</button>
        </div>
      </div>
    </div>
  );
}

// ── Deadline detail side panel ─────────────────────────────────────
// 시간 블록/할 일 상세 패널과 같은 오른쪽 자리에 뜨는 라이트 버전. 마감 작업은 카테고리/체크리스트
// 개념이 없어 제목·마감일·완료 토글·삭제만 노출. 색상은 D-day 톤이 자동으로 결정.
function DeadlineDetailPanel({
  deadline, onClose, onToggle, onDelete, onTitleSave, onDueDateSave,
}: {
  deadline: Deadline;
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onTitleSave: (title: string) => void;
  onDueDateSave: (dueDate: string) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(deadline.title);
  const daysLeft = daysBetween(parseLocalDate(deadline.dueDate), TODAY_DATE);
  // D-day 배지 색(항상 규칙) 과 블록 색(커스텀 우선) 을 분리.
  const dayColor = deadlineToneHex(daysLeft);
  const blockColor = deadline.color || dayColor;

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== deadline.title) onTitleSave(trimmed);
    else setTitleDraft(deadline.title);
    setEditingTitle(false);
  };

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      {/* Header — 색 스와치는 마감 커스텀 색을 따라감(없으면 D-day 톤). 배지는 항상 D-day 톤. */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border flex-shrink-0">
        <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: blockColor }} />
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { setTitleDraft(deadline.title); setEditingTitle(false); }
            }}
            className="flex-1 min-w-0 text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5"
          />
        ) : (
          <button
            onClick={() => { setTitleDraft(deadline.title); setEditingTitle(true); }}
            title="제목 편집"
            className="flex-1 min-w-0 text-left text-sm font-medium truncate hover:bg-muted/40 rounded px-1 py-0.5 transition-colors"
          >
            {deadline.title}
          </button>
        )}
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: dayColor + "22", color: dayColor }}
        >{formatDDay(daysLeft)}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* 마감일 — 네이티브 date picker. 변경 즉시 저장. */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">마감일</div>
          <input
            type="date"
            value={deadline.dueDate}
            onChange={e => {
              const v = e.target.value;
              if (v && v !== deadline.dueDate) onDueDateSave(v);
            }}
            className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="text-[11px] text-muted-foreground mt-1.5">
            {deadline.dueDate} ({DAYS_KO[parseLocalDate(deadline.dueDate).getDay()]})
          </div>
        </div>

        {/* 완료 토글 */}
        <button
          onClick={onToggle}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors ${
            deadline.completed ? "bg-muted/40 border-transparent" : "bg-card border-border hover:border-primary/40"
          }`}
        >
          {deadline.completed
            ? <CheckCircle2 size={16} style={{ color: blockColor }} />
            : <Circle size={16} className="text-muted-foreground" />}
          <span className={`text-xs ${deadline.completed ? "text-muted-foreground line-through" : ""}`}>
            {deadline.completed ? "완료됨 — 다시 열기" : "완료 처리"}
          </span>
        </button>

        {/* Delete */}
        <button
          onClick={() => { onDelete(); onClose(); }}
          className="w-full text-[11px] text-destructive hover:bg-destructive/10 rounded-lg py-2 transition-colors"
        >
          마감 삭제
        </button>

        <div className="space-y-1.5">
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
          >저장</button>
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted transition-colors"
          >닫기</button>
        </div>
      </div>
    </div>
  );
}
