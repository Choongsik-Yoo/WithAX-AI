import JSZip from 'jszip';

export type Entry = { source: 'claude' | 'chatgpt' | 'gemini' | 'summary'; date: string; text: string; label: string; selected: boolean };
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' ? value as Obj : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === 'string' ? value : '';
const normalize = (value: unknown) => {
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(str(value));
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0,10) : '';
};

const masks = [
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,
  /\b\d{6}[- ]?[1-8]\d{6}\b/g,
  /\b0\d{1,2}[- .]?\d{3,4}[- .]?\d{4}\b/g,
  /\b\d{2,6}[- ]\d{2,6}[- ]\d{2,10}(?:[- ]\d{1,8})?\b/g,
  /\b\d{9,16}\b/g,
  /(?:이름|성명|담당자|고객명)\s*[:：]\s*[가-힣]{2,5}/g,
];
export const mask = (value: string) => masks.reduce((result, regex) => result.replace(regex, '[가림]'), value);

function turns(value: unknown) {
  return arr(value).flatMap(item => {
    const row = object(item);
    return [str(row.text) || arr(row.content).map(content => str(object(content).text)).join(' ')];
  }).filter(Boolean).join('\n');
}

function fromJson(json: unknown, source: Entry['source']) {
  const rows = Array.isArray(json) ? json : arr(object(json).conversations ?? object(json).activities);
  return rows.map(value => {
    const item = object(value);
    if (source === 'chatgpt') {
      const mapping = object(item.mapping);
      const active = [];
      let id = str(item.current_node);
      const seen = new Set<string>();
      while (id && !seen.has(id) && mapping[id]) {
        seen.add(id);
        const node = object(mapping[id]);
        const message = object(node.message);
        if (['user','assistant'].includes(str(object(message.author).role))) {
          active.push(arr(object(message.content).parts).map(str).filter(Boolean).join(' '));
        }
        id = str(node.parent);
      }
      return { title: str(item.title), date: normalize(item.create_time), text: active.reverse().join('\n') };
    }
    if (source === 'claude') return { title: str(item.name), date: normalize(item.created_at), text: turns(item.chat_messages) };
    return { title: str(item.title), date: normalize(item.time), text: str(item.title) + '\n' + str(item.description) };
  });
}

function fromHtml(html: string) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return [...dom.querySelectorAll('.outer-cell')].map(node => {
    const title = node.querySelector('.content-cell')?.textContent?.trim() ?? '';
    const dateText = title.match(/\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2} \d{1,2}, \d{4}|\d{4}년\s*\d{1,2}월\s*\d{1,2}일/)?.[0] ?? '';
    return { title: title.slice(0,120), date: normalize(dateText.replace(/(\d+)년\s*(\d+)월\s*(\d+)일/, '$1/$2/$3')), text: title };
  });
}

export async function readRecords(file: File, source: Exclude<Entry['source'],'summary'>, period: { from: string; to: string }, keywords: { work: string[]; personal: string[] }) {
  if (file.size > 30 * 1024 * 1024) throw new Error('30MB 이하의 파일을 선택하세요.');
  const parse = (name: string, body: string) => name.toLowerCase().endsWith('.html')
    ? fromHtml(body) : fromJson(JSON.parse(body), source);
  let rows;
  if (file.name.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(entry => !entry.dir && (source === 'gemini'
      ? /(?:gemini|제미나이).*\.(json|html)$/i.test(entry.name)
      : /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(entry.name)));
    if (!entries.length || entries.length > 20) throw new Error('지원하는 대화 파일을 ZIP에서 찾지 못했습니다.');
    rows = [];
    for (const entry of entries) {
      const body = await entry.async('string');
      if (body.length > 40_000_000) throw new Error('압축 해제한 파일이 너무 큽니다.');
      rows.push(...parse(entry.name, body));
    }
  } else rows = parse(file.name, await file.text());
  let excluded = 0;
  const results: Entry[] = [];
  for (const row of rows) {
    const combined = (row.title + '\n' + row.text).toLowerCase();
    if (!row.text.trim() || !row.date || row.date < period.from || row.date > period.to
      || keywords.personal.some(word => combined.includes(word.toLowerCase()))) { excluded++; continue; }
    const selected = keywords.work.some(word => combined.includes(word.toLowerCase()));
    results.push({ source, date: row.date, label: mask(row.title).slice(0,120), text: mask(row.text).slice(0,1800), selected });
  }
  if (!rows.length) throw new Error('지원하는 구조의 기록이 없습니다. 내보내기 형식을 확인하세요.');
  return { entries: results.slice(0,300), excluded, truncated: Math.max(0,results.length - 300) };
}

export function readSummary(value: string, period: { from: string; to: string }, keywords: string[]): Entry {
  const json = object(JSON.parse(value));
  const supplied = object(json.period);
  if (json.promptVersion !== 'v2.0' || supplied.from !== period.from || supplied.to !== period.to) {
    throw new Error('Claude 표준 JSON의 버전과 평가 대상 기간을 확인하세요.');
  }
  const content = arr(json.indicators).flatMap(item => {
    const row = object(item);
    const code = str(row.code);
    return ['A1','A2','A3','A4','B2'].includes(code)
      ? arr(row.observations).map(str).filter(line => line.trim() && !keywords.some(word => line.toLowerCase().includes(word.toLowerCase()))).map(line => code + ' ' + line)
      : [];
  }).join('\n');
  if (!content) throw new Error('평가 근거를 찾지 못했습니다.');
  return { source: 'summary', date: period.to, label: 'Claude 자가분석 요약', text: mask(content).slice(0,1800), selected: true };
}
