/**
 * NotebookLM RPC response parsers.
 */

import { parseEnvelopes } from './boq-parser.js';
import type {
  NotebookInfo,
  SourceInfo,
  ArtifactInfo,
  StudioConfig,
  StudioAudioType,
  StudioDocType,
  AccountInfo,
  ResearchResult,
  Flashcard,
} from './types.js';
type QuotaInfo = AccountInfo;

const FLASHCARD_FRONT_KEYS = ['front', 'frontText', 'front_text', 'question', 'term', 'prompt', 'f'] as const;
const FLASHCARD_BACK_KEYS = ['back', 'backText', 'back_text', 'answer', 'definition', 'response', 'b'] as const;

// ── Helpers ──

function get(data: unknown, ...path: number[]): unknown {
  let current: unknown = data;
  for (const idx of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[idx];
  }
  return current;
}

function getString(data: unknown, ...path: number[]): string {
  const val = get(data, ...path);
  return typeof val === 'string' ? val : '';
}

function getArray(data: unknown, ...path: number[]): unknown[] | null {
  const val = get(data, ...path);
  return Array.isArray(val) ? val : null;
}

function extractInner(raw: string): unknown {
  const envelopes = parseEnvelopes(raw);
  return envelopes.length > 0 ? envelopes[0] : null;
}

function extractAllInner(raw: string): unknown[] {
  return parseEnvelopes(raw);
}

function unwrapSingletonArrays<T>(value: T): T {
  let current: unknown = value;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }
  return current as T;
}

function isLikelyArtifactId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{3,}$/.test(value)
    && !value.startsWith('http')
    && !value.includes('<');
}

function findArtifactTuple(data: unknown, depth = 0): unknown[] | null {
  if (depth > 8 || !Array.isArray(data)) return null;

  const entry = unwrapSingletonArrays(data);
  if (Array.isArray(entry) && isLikelyArtifactId(entry[0])) {
    const title = typeof entry[1] === 'string' ? entry[1] : '';
    if (title || typeof entry[2] === 'number' || entry.length <= 4) {
      return entry;
    }
  }

  for (const item of entry) {
    const found = findArtifactTuple(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function looksLikeArtifactEntry(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const entry = unwrapSingletonArrays(value);
  return Array.isArray(entry)
    && isLikelyArtifactId(entry[0])
    && (typeof entry[1] === 'string' || typeof entry[2] === 'number' || Array.isArray(entry[3]));
}

function collectArtifactEntries(data: unknown, results: unknown[][] = [], seen = new Set<string>(), depth = 0): unknown[][] {
  if (depth > 10 || !Array.isArray(data)) return results;

  const entry = unwrapSingletonArrays(data);
  if (looksLikeArtifactEntry(entry)) {
    const artifactId = entry[0] as string;
    if (!seen.has(artifactId)) {
      seen.add(artifactId);
      results.push(entry);
    }
  }

  for (const item of entry) {
    collectArtifactEntries(item, results, seen, depth + 1);
  }

  return results;
}

function collectSourceIds(data: unknown, seen = new Set<string>(), depth = 0): string[] {
  if (depth > 6 || !Array.isArray(data)) return [...seen];
  for (const item of data) {
    if (Array.isArray(item) && Array.isArray(item[0]) && typeof item[0][0] === 'string') {
      seen.add(item[0][0]);
      continue;
    }
    if (Array.isArray(item) && typeof item[0] === 'string' && item.length === 1) {
      seen.add(item[0]);
      continue;
    }
    collectSourceIds(item, seen, depth + 1);
  }
  return [...seen];
}

// ── Notebook CRUD Parsers ──

export function parseCreateNotebook(raw: string): { notebookId: string } {
  const inner = extractInner(raw);
  const id = getString(inner, 2);
  if (!id) throw new Error('Failed to parse notebook ID from create response');
  return { notebookId: id };
}

export function parseListNotebooks(raw: string): NotebookInfo[] {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return [];

  const entries = Array.isArray(inner[0]) ? inner[0] as unknown[] : inner;
  const notebooks: NotebookInfo[] = [];

  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const title = typeof entry[0] === 'string' ? entry[0] : '';
    const id = typeof entry[2] === 'string' ? entry[2] : '';
    if (id && /^[0-9a-f]{8}-/.test(id)) {
      const sourceCount = Array.isArray(entry[1]) ? entry[1].length : undefined;
      notebooks.push({ id, title, sourceCount });
    }
  }

  return notebooks;
}

export function parseNotebookDetail(raw: string): { title: string; sources: SourceInfo[] } {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { title: '', sources: [] };

  const entry = Array.isArray(inner[0]) ? inner[0] as unknown[] : inner;
  const title = typeof entry[0] === 'string' ? entry[0] : '';
  const sources: SourceInfo[] = [];
  const sourcesArr = Array.isArray(entry[1]) ? entry[1] as unknown[] : [];

  for (const srcEntry of sourcesArr) {
    if (!Array.isArray(srcEntry)) continue;
    let id = '';
    const first = srcEntry[0];
    if (Array.isArray(first) && typeof first[0] === 'string') {
      id = first[0];
    }
    const sourceTitle = typeof srcEntry[1] === 'string' ? srcEntry[1] : '';
    if (id) {
      const meta = Array.isArray(srcEntry[2]) ? srcEntry[2] as unknown[] : [];
      const wordCount = typeof meta[1] === 'number' ? meta[1] : undefined;
      let url: string | undefined;
      if (Array.isArray(meta[7]) && typeof meta[7][0] === 'string') {
        url = meta[7][0];
      } else if (typeof meta[7] === 'string') {
        url = meta[7];
      }
      sources.push({ id, title: sourceTitle, wordCount, url });
    }
  }

  return { title, sources };
}

// ── Source Parsers ──

export function parseAddSource(raw: string): { sourceId: string; title: string } {
  const inner = extractInner(raw);
  const entry = getArray(inner, 0, 0);
  if (!entry) return { sourceId: '', title: '' };
  const idArr = getArray(entry, 0);
  const id = idArr && typeof idArr[0] === 'string' ? idArr[0] : '';
  const title = getString(entry, 1);
  return { sourceId: id, title };
}

export function parseListSourceThreads(raw: string): string[] {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return [];
  const threads: string[] = [];
  for (const entry of inner) {
    if (Array.isArray(entry) && Array.isArray(entry[0]) && typeof entry[0][0] === 'string') {
      threads.push(entry[0][0]);
    }
  }
  return threads;
}

export function parseSourceContent(raw: string): { id: string; title: string; wordCount: number } {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { id: '', title: '', wordCount: 0 };
  const idArr = getArray(inner, 0);
  const id = idArr && typeof idArr[0] === 'string' ? idArr[0] : '';
  const title = getString(inner, 1);
  const meta = getArray(inner, 2);
  const wordCount = meta && typeof meta[1] === 'number' ? meta[1] : 0;
  return { id, title, wordCount };
}

export function parseSourceSummary(raw: string): { sourceId: string; summary: string } {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { sourceId: '', summary: '' };
  const sourceId = getString(inner, 0, 0, 0, 0);
  const summary = typeof inner[1] === 'string' ? inner[1] : '';
  return { sourceId, summary };
}

// ── Artifact Parsers ──

export function parseGenerateArtifact(raw: string): { artifactId: string; title: string } {
  const inner = extractInner(raw);
  const entry = findArtifactTuple(inner);
  if (!entry) return { artifactId: '', title: '' };
  const artifactId = typeof entry[0] === 'string' ? entry[0] : '';
  const title = typeof entry[1] === 'string' ? entry[1] : '';
  return { artifactId, title };
}

export function parseArtifacts(raw: string): ArtifactInfo[] {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return [];

  const artifacts: ArtifactInfo[] = [];
  for (const entry of collectArtifactEntries(inner)) {
    const artifactId = typeof entry[0] === 'string' ? entry[0] : '';
    if (!artifactId) continue;

    const artifact: ArtifactInfo = {
      id: artifactId,
      title: typeof entry[1] === 'string' ? entry[1] : '',
      type: typeof entry[2] === 'number' ? entry[2] : 0,
    };

    const sourceIds = collectSourceIds(entry[3]);
    if (sourceIds.length > 0) artifact.sourceIds = sourceIds;

    const mediaUrls = findMediaUrls(entry);
    if (mediaUrls.download) artifact.downloadUrl = mediaUrls.download;
    if (mediaUrls.stream) artifact.streamUrl = mediaUrls.stream;
    if (mediaUrls.hls) artifact.hlsUrl = mediaUrls.hls;
    if (mediaUrls.dash) artifact.dashUrl = mediaUrls.dash;
    if (mediaUrls.durationSeconds !== undefined) artifact.durationSeconds = mediaUrls.durationSeconds;
    if (mediaUrls.durationNanos !== undefined) artifact.durationNanos = mediaUrls.durationNanos;

    artifacts.push(artifact);
  }

  return artifacts;
}

interface MediaUrls {
  download?: string;
  stream?: string;
  hls?: string;
  dash?: string;
  durationSeconds?: number;
  durationNanos?: number;
}

function findMediaUrls(data: unknown, depth = 0): MediaUrls {
  if (depth > 12 || data === null || data === undefined) return {};

  if (Array.isArray(data)) {
    if (data.length === 2 && typeof data[0] === 'number' && typeof data[1] === 'number'
        && data[0] > 10 && data[0] < 100000 && data[1] > 1000000) {
      return { durationSeconds: data[0], durationNanos: data[1] };
    }

    if (data.length >= 2 && Array.isArray(data[0])) {
      const first = data[0];
      if (typeof first[0] === 'string' && first[0].includes('googleusercontent.com/notebooklm/')) {
        const result: MediaUrls = {};
        for (const variant of data) {
          if (!Array.isArray(variant) || typeof variant[0] !== 'string') continue;
          const url = variant[0] as string;
          const typeCode = variant[1];
          if (url.includes('=m140-dv') || typeCode === 4) result.download = url;
          else if (url.includes('=m140') || typeCode === 1) result.stream = url;
          else if (url.includes('=mm,hls') || typeCode === 2) result.hls = url;
          else if (url.includes('=mm,dash') || typeCode === 3) result.dash = url;
        }
        return result;
      }
    }

    const merged: MediaUrls = {};
    for (const item of data) {
      const found = findMediaUrls(item, depth + 1);
      Object.assign(merged, found);
    }
    return merged;
  }

  return {};
}

export function findArtifactDownloadUrl(raw: string, artifactId: string): string | null {
  const artifacts = parseArtifacts(raw);
  const artifact = artifacts.find((a) => a.id === artifactId);
  return artifact?.downloadUrl ?? null;
}

function decodeCapturedString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/');
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeCardText(value: string): string {
  return decodeHtmlEntities(
    decodeCapturedString(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|section|article|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function addFlashcard(cards: Flashcard[], seen: Set<string>, frontRaw: string, backRaw: string): void {
  const front = normalizeCardText(frontRaw);
  const back = normalizeCardText(backRaw);
  if (!front || !back) return;
  const key = `${front}\u241F${back}`;
  if (seen.has(key)) return;
  seen.add(key);
  cards.push({ front, back });
}

function firstDefinedProp(props: Map<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = props.get(key);
    if (value) return value;
  }
  return '';
}

function extractFlashcardsFromObjectSnippets(source: string, cards: Flashcard[], seen: Set<string>): void {
  const objectRegex = /\{[\s\S]{0,4000}?"(?:front|frontText|front_text|back|backText|back_text|question|answer|term|definition|prompt|response|f|b)"\s*:\s*"(?:\\.|[^"\\])*"[\s\S]{0,4000}?\}/g;
  const propRegex = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

  for (const match of source.matchAll(objectRegex)) {
    const snippet = match[0];
    if (!snippet) continue;

    const props = new Map<string, string>();
    for (const propMatch of snippet.matchAll(propRegex)) {
      const key = propMatch[1];
      const value = propMatch[2];
      if (key !== undefined && value !== undefined) {
        props.set(key, value);
      }
    }

    const front = firstDefinedProp(props, FLASHCARD_FRONT_KEYS);
    const back = firstDefinedProp(props, FLASHCARD_BACK_KEYS);
    if (front && back) addFlashcard(cards, seen, front, back);
  }
}

function extractFlashcardsFromDom(source: string, cards: Flashcard[], seen: Set<string>): void {
  const containerRegex = /<(section|article|li|div)\b[^>]*\b(?:flashcard|card)\b[^>]*>([\s\S]{1,4000}?)<\/\1>/gi;
  const pairRegex = /<[^>]*(?:front|question|term|prompt)[^>]*>([\s\S]{1,1200}?)<\/[^>]+>[\s\S]{0,1200}?<[^>]*(?:back|answer|definition|response)[^>]*>([\s\S]{1,1200}?)<\/[^>]+>/i;

  for (const match of source.matchAll(containerRegex)) {
    const block = match[2];
    if (!block) continue;
    const pair = pairRegex.exec(block);
    if (!pair) continue;
    const front = pair[1];
    const back = pair[2];
    if (front !== undefined && back !== undefined) {
      addFlashcard(cards, seen, front, back);
    }
  }
}

export function extractFlashcardsFromHtml(html: string): Flashcard[] {
  if (!html) return [];

  const cards: Flashcard[] = [];
  const seen = new Set<string>();
  const sources = [html, decodeHtmlEntities(html)];

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1]) {
      sources.push(match[1]);
      sources.push(decodeHtmlEntities(match[1]));
    }
  }

  for (const source of sources) {
    extractFlashcardsFromObjectSnippets(source, cards, seen);
  }

  if (cards.length === 0) {
    for (const source of sources) {
      extractFlashcardsFromDom(source, cards, seen);
    }
  }

  return cards;
}

export function renderFlashcardsMarkdown(cards: Flashcard[]): string {
  const lines = ['# Flashcards', ''];
  if (cards.length === 0) {
    lines.push('_No flashcards could be parsed from the exported HTML. Check the exported HTML or regenerate the artifact._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`> Total cards: ${cards.length}`);
  lines.push('');

  cards.forEach((card, index) => {
    lines.push(`## Card ${index + 1}`);
    lines.push('');
    lines.push('### Front');
    lines.push(card.front);
    lines.push('');
    lines.push('### Back');
    lines.push(card.back);
    lines.push('');
    if (index < cards.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });

  return lines.join('\n');
}

// ── Chat Parser ──

export function parseChatStream(raw: string): { text: string; threadId: string; responseId: string } {
  const inners = extractAllInner(raw);

  let lastText = '';
  let threadId = '';
  let responseId = '';

  for (const inner of inners) {
    if (!Array.isArray(inner)) continue;
    const payload = Array.isArray(inner[0]) ? inner[0] as unknown[] : inner;
    const text = typeof payload[0] === 'string' ? payload[0] : '';
    if (text) {
      lastText = text;
    }
    const meta = getArray(payload, 2);
    if (meta) {
      if (typeof meta[0] === 'string' && meta[0]) threadId = meta[0];
      if (typeof meta[1] === 'string' && meta[1]) responseId = meta[1];
    }
  }

  return { text: lastText, threadId, responseId };
}

// ── Studio Config Parser ──

export function parseStudioConfig(raw: string): StudioConfig {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { audioTypes: [], explainerTypes: [], slideTypes: [], docTypes: [] };

  const sections = Array.isArray(inner[0]) ? inner[0] as unknown[] : inner;

  function parseTypedSection(section: unknown): StudioAudioType[] {
    if (!Array.isArray(section) || !Array.isArray(section[0])) return [];
    const items = section[0] as unknown[];
    return items.filter(Array.isArray).map((item: unknown) => {
      const arr = item as unknown[];
      return {
        id: typeof arr[0] === 'number' ? arr[0] : 0,
        name: typeof arr[1] === 'string' ? arr[1] : '',
        description: typeof arr[2] === 'string' ? arr[2] : '',
      };
    });
  }

  function parseDocSection(section: unknown): StudioDocType[] {
    if (!Array.isArray(section) || !Array.isArray(section[0])) return [];
    const items = section[0] as unknown[];
    return items.filter(Array.isArray).map((item: unknown) => {
      const arr = item as unknown[];
      return {
        name: typeof arr[0] === 'string' ? arr[0] : '',
        description: typeof arr[1] === 'string' ? arr[1] : '',
      };
    });
  }

  return {
    audioTypes: parseTypedSection(sections[0]),
    explainerTypes: parseTypedSection(sections[1]),
    slideTypes: parseTypedSection(sections[2]),
    docTypes: parseDocSection(sections[3]),
  };
}

// ── Quota Parser ──

export function parseQuota(raw: string): QuotaInfo {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { planType: 0, notebookLimit: 0, sourceLimit: 0, sourceWordLimit: 0, isPlus: false };

  // Response: [[null, [planType, notebookLimit, sourceLimit, sourceWordLimit, ?], [bool], [[?]], [isPlus, ?, ?, ?]]]
  // RPC: GetOrCreateAccount → account config, NOT usage/remaining counts
  const entry = Array.isArray(inner[0]) && !Array.isArray(inner[1]) ? inner[0] as unknown[] : inner;
  const limits = Array.isArray(entry[1]) ? entry[1] as number[] : [];
  const flags = Array.isArray(entry[4]) ? entry[4] as unknown[] : [];

  return {
    planType: typeof limits[0] === 'number' ? limits[0] : 0,
    notebookLimit: typeof limits[1] === 'number' ? limits[1] : 0,
    sourceLimit: typeof limits[2] === 'number' ? limits[2] : 0,
    sourceWordLimit: typeof limits[3] === 'number' ? limits[3] : 0,
    isPlus: flags[0] === true,
  };
}

// ── Research Results Parser ──

/**
 * Parse POLL_RESEARCH (e3bVqc) response for research results.
 *
 * Response: [[[taskId, taskInfo, ts1, ts2], ...]]
 * taskInfo: [notebookId, [query, sourceType], innerStatus, sourcesAndSummary?, statusCode?]
 *
 * statusCode: 1=in_progress, 2=completed (fast), 6=completed (deep)
 *
 * sourcesAndSummary:
 *   [[url, title, desc, type], ...], "summary"]   (HTTP transport, nested)
 *   [[url, title, desc, type], ...]                (browser capture, flat)
 *
 * Deep research report entries:
 *   [null, [title, markdown], null, 3, ...]        (current format)
 *   [null, title, null, type, ..., [chunks]]       (legacy format)
 */
export function parseResearchResults(raw: string): { status: number; results: ResearchResult[]; report?: string } {
  const inner = extractInner(raw);
  if (!Array.isArray(inner)) return { status: 0, results: [] };

  // Navigate to the task entry: inner → [[entry, ...]] → entry
  const outerList = getArray(inner, 0);
  if (!outerList) return { status: 0, results: [] };

  const wrapper = Array.isArray(outerList[0]) ? outerList[0] as unknown[] : outerList;
  let entryArr: unknown[] | null = null;
  if (typeof wrapper[0] === 'string') {
    entryArr = wrapper;
  } else if (Array.isArray(wrapper[0]) && typeof wrapper[0][0] === 'string') {
    entryArr = wrapper[0] as unknown[];
  }
  if (!entryArr) return { status: 0, results: [] };

  const taskInfo = getArray(entryArr, 1);
  if (!taskInfo) return { status: 0, results: [] };

  // statusCode at taskInfo[4]: 2=completed (fast), 6=completed (deep)
  const statusCode = typeof taskInfo[4] === 'number' ? taskInfo[4] : (typeof taskInfo[2] === 'number' ? taskInfo[2] : 0);
  const isCompleted = statusCode === 2 || statusCode === 6;
  const status = isCompleted ? 2 : statusCode; // normalize to 2 for completed

  const results: ResearchResult[] = [];
  let report: string | undefined;

  let sourcesAndSummary = getArray(taskInfo, 3);
  if (!sourcesAndSummary) return { status, results };

  // Unwrap nested format: [[[url,title,...], ...], "summary"] → [[url,title,...], ...]
  let sourceItems: unknown[];
  if (sourcesAndSummary.length > 0 && Array.isArray(sourcesAndSummary[0]) && Array.isArray(sourcesAndSummary[0][0])) {
    sourceItems = sourcesAndSummary[0] as unknown[];
  } else {
    sourceItems = sourcesAndSummary;
  }

  for (const item of sourceItems) {
    if (!Array.isArray(item)) continue;

    // Deep research report entry: [null, [title, markdown], null, 3, ...]
    if (item[0] === null && Array.isArray(item[1]) && typeof item[1][0] === 'string' && typeof item[1][1] === 'string') {
      if (!report) report = item[1][1];
      continue;
    }
    // Legacy report: [null, title, null, type, ..., [chunks]]
    if (item[0] === null && typeof item[1] === 'string' && Array.isArray(item[6])) {
      const chunks = (item[6] as unknown[]).filter((c): c is string => typeof c === 'string');
      if (chunks.length > 0 && !report) report = chunks.join('\n\n');
      continue;
    }

    // URL source: [url, title, desc, type]
    const url = typeof item[0] === 'string' ? item[0] : '';
    const title = typeof item[1] === 'string' ? item[1] : '';
    const description = typeof item[2] === 'string' ? item[2] : '';
    if (url) results.push({ url, title, description });
  }

  return { status, results, report };
}

// Re-export Boq utilities
export { parseEnvelopes, stripSafetyPrefix } from './boq-parser.js';
