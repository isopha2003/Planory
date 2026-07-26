// 대한민국 공휴일 계산 — 캘린더에서 빨간색·이름 표시에 사용.
//
// 원리:
//   - 양력 고정 공휴일: 코드에 (month, day, name) 튜플로 나열.
//   - 음력 기반 공휴일(설날/부처님오신날/추석): korean-lunar-calendar 로 연도별 음→양 변환.
//   - 대체공휴일: 공휴일 그룹이 토·일과 겹치면 그룹 종료 다음 첫 평일(비공휴일) 하나를 대체.
//     신정과 현충일은 규정상 대체공휴일 대상이 아니므로 제외.
//
// 왜 라이브러리:
//   전엔 5년치 하드코딩이었지만 사용자가 그 이후에도 자동 표시 원함. 음력→양력 매핑은 매년
//   달라 손으로 갱신이 부담이라, KARI 표를 내장한 오프라인 라이브러리(zero-deps, ~10KB) 채택.
//
// 정확도 한계:
//   대체공휴일 규정은 정치적으로 자주 개정되므로(예: 2021 확대, 2023 추가) 이 계산은 근사값.
//   임시공휴일(선거일, 경축식 등)은 예측 불가라 아예 포함 안 함. 완전 정확한 표는 KASI 발표 참조.
//
// 라이브러리 지원 범위: 양력 1000-02-13 ~ 2050-12-31 → 이 범위 밖 요청은 null.
import KoreanLunarCalendar from "korean-lunar-calendar";

// [month, day, name, substituteEligible]
// substituteEligible=false: 신정/현충일은 대체공휴일 대상 아님.
const FIXED_HOLIDAYS: Array<[number, number, string, boolean]> = [
  [1, 1, "신정", false],
  [3, 1, "삼일절", true],
  [5, 5, "어린이날", true],
  [6, 6, "현충일", false],
  [8, 15, "광복절", true],
  [10, 3, "개천절", true],
  [10, 9, "한글날", true],
  [12, 25, "크리스마스", true],
];

// 라이브러리가 커버하는 양력 범위. 밖의 연도는 계산하지 않고 빈 결과.
const MIN_YEAR = 1900;
const MAX_YEAR = 2050;

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
};

// 공휴일 그룹(연속된 하루~여러 날) 이 토·일과 겹치면 그룹 종료 다음 첫 평일(비공휴일) 하나를
// 대체공휴일로 지정. 설날/추석 연휴 3일은 하나의 그룹으로 취급 → 대체공휴일도 최대 1일.
// 이미 공휴일인 날은 건너뜀(예: 2027 한글날 대체는 개천절 대체 다음 날로 밀림).
function addSubstitute(
  holidays: Record<string, string>,
  groupDates: Date[],
  originName: string,
) {
  const hasWeekendOverlap = groupDates.some(d => d.getDay() === 0 || d.getDay() === 6);
  if (!hasWeekendOverlap) return;
  let cur = groupDates[groupDates.length - 1];
  while (true) {
    cur = addDays(cur, 1);
    const dow = cur.getDay();
    if (dow === 0 || dow === 6) continue;
    if (holidays[fmtDate(cur)]) continue;
    holidays[fmtDate(cur)] = `대체공휴일 (${originName})`;
    return;
  }
}

const cache = new Map<number, Record<string, string>>();

function computeYear(year: number): Record<string, string> {
  if (year < MIN_YEAR || year > MAX_YEAR) return {};

  const holidays: Record<string, string> = {};
  // 대체공휴일 계산 대상 그룹들 — [그룹 이름, 그룹 날짜들].
  const groups: Array<{ name: string; dates: Date[] }> = [];

  // 양력 고정 공휴일.
  for (const [m, d, name, subEligible] of FIXED_HOLIDAYS) {
    const date = new Date(year, m - 1, d);
    holidays[fmtDate(date)] = name;
    if (subEligible) groups.push({ name, dates: [date] });
  }

  // 음력 기반 공휴일 — 라이브러리로 연도별 양력 변환.
  const cal = new KoreanLunarCalendar();

  // 설날 연휴: 음력 1/1 기준 전날/당일/다음날.
  if (cal.setLunarDate(year, 1, 1, false)) {
    const s = cal.getSolarCalendar();
    const seolnal = new Date(s.year, s.month - 1, s.day);
    const prev = addDays(seolnal, -1);
    const next = addDays(seolnal, 1);
    holidays[fmtDate(prev)] = "설날 연휴";
    holidays[fmtDate(seolnal)] = "설날";
    holidays[fmtDate(next)] = "설날 연휴";
    groups.push({ name: "설날", dates: [prev, seolnal, next] });
  }

  // 부처님오신날: 음력 4/8.
  if (cal.setLunarDate(year, 4, 8, false)) {
    const s = cal.getSolarCalendar();
    const d = new Date(s.year, s.month - 1, s.day);
    holidays[fmtDate(d)] = "부처님오신날";
    groups.push({ name: "부처님오신날", dates: [d] });
  }

  // 추석 연휴: 음력 8/15 기준 전날/당일/다음날.
  if (cal.setLunarDate(year, 8, 15, false)) {
    const s = cal.getSolarCalendar();
    const chuseok = new Date(s.year, s.month - 1, s.day);
    const prev = addDays(chuseok, -1);
    const next = addDays(chuseok, 1);
    holidays[fmtDate(prev)] = "추석 연휴";
    holidays[fmtDate(chuseok)] = "추석";
    holidays[fmtDate(next)] = "추석 연휴";
    groups.push({ name: "추석", dates: [prev, chuseok, next] });
  }

  // 대체공휴일 계산 — 모든 원래 공휴일이 확정된 뒤 실행해야 "이미 공휴일인 날 스킵" 규칙이
  // 정확히 작동. 여러 그룹의 대체가 같은 다음 평일을 노리는 경우 순서대로 하루씩 밀림.
  for (const g of groups) {
    addSubstitute(holidays, g.dates, g.name);
  }

  return holidays;
}

function ensureYear(year: number): Record<string, string> {
  let y = cache.get(year);
  if (!y) {
    y = computeYear(year);
    cache.set(year, y);
  }
  return y;
}

/** 해당 YYYY-MM-DD 가 공휴일이면 이름 반환, 아니면 null. */
export function getHoliday(dateStr: string): string | null {
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  return ensureYear(year)[dateStr] ?? null;
}

/** 공휴일 여부(색상 판정용 shortcut). */
export function isHoliday(dateStr: string): boolean {
  return getHoliday(dateStr) !== null;
}
