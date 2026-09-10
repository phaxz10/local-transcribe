import type { TranscriptRecord, ExportFormat, ExportLayer } from './types'
import { timestamp } from './utils'

interface SegView {
  start: number
  end: number
  text: string
  /** Speaker name, when the Segment has one. The raw ASR layer never does. */
  speaker?: string
}

function joinWords(texts: string[]): string {
  return texts
    .join(' ')
    .replace(/\s+([,.!?;:’'”)\]])/g, '$1')
    .replace(/([(\[“])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function segmentsView(record: TranscriptRecord, layer: ExportLayer): SegView[] {
  if (layer === 'raw') {
    return record.asr.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: joinWords(s.words.map((w) => w.text)),
    }))
  }
  return record.edit.segments
    .map((s) => {
      const ws = s.words
      return {
        start: ws[0]?.start ?? 0,
        end: ws[ws.length - 1]?.end ?? ws[0]?.start ?? 0,
        text: joinWords(ws.map((w) => w.text)),
        speaker: s.speakerId ? record.speakers?.[s.speakerId]?.name : undefined,
      }
    })
    .filter((s) => s.text.length > 0)
}

/**
 * Prefix each Segment where the Speaker *changes*, the way a script reads. With no Speakers
 * assigned this is the identity map, so old transcripts export exactly as before (ADR-0017).
 */
function withSpeakers(views: SegView[], label: (name: string, text: string) => string): string[] {
  let prev: string | undefined
  return views.map((s) => {
    const changed = s.speaker != null && s.speaker !== prev
    prev = s.speaker
    return changed ? label(s.speaker!, s.text) : s.text
  })
}

function toText(r: TranscriptRecord, l: ExportLayer): string {
  return withSpeakers(segmentsView(r, l), (n, t) => `${n}: ${t}`).join('\n')
}

function toSrt(r: TranscriptRecord, l: ExportLayer): string {
  const views = segmentsView(r, l)
  const texts = withSpeakers(views, (n, t) => `${n}: ${t}`)
  return views
    .map(
      (s, i) =>
        `${i + 1}\n${timestamp(s.start, ',')} --> ${timestamp(s.end, ',')}\n${texts[i]}\n`,
    )
    .join('\n')
}

function toVtt(r: TranscriptRecord, l: ExportLayer): string {
  const views = segmentsView(r, l)
  // WebVTT has a first-class voice span; use it rather than baking the name into the caption text.
  const texts = withSpeakers(views, (n, t) => `<v ${n}>${t}`)
  return (
    'WEBVTT\n\n' +
    views
      .map((s, i) => `${timestamp(s.start, '.')} --> ${timestamp(s.end, '.')}\n${texts[i]}\n`)
      .join('\n')
  )
}

function toMarkdown(r: TranscriptRecord, l: ExportLayer): string {
  const head =
    `# ${r.source.filename}\n\n` +
    `- **Model:** ${r.model}\n` +
    `- **Duration:** ${timestamp(r.source.durationSec, '.')}\n` +
    `- **Language:** ${r.asr.language}\n\n---\n\n`
  const views = segmentsView(r, l)
  const texts = withSpeakers(views, (n, t) => `**${n}:** ${t}`)
  return (
    head +
    views.map((s, i) => `**[${timestamp(s.start, '.')}]** ${texts[i]}`).join('\n\n')
  )
}

export function exportTranscript(
  record: TranscriptRecord,
  format: ExportFormat,
  layer: ExportLayer,
): { text: string; mime: string; ext: string } {
  switch (format) {
    case 'txt':
      return { text: toText(record, layer), mime: 'text/plain', ext: 'txt' }
    case 'srt':
      return { text: toSrt(record, layer), mime: 'application/x-subrip', ext: 'srt' }
    case 'vtt':
      return { text: toVtt(record, layer), mime: 'text/vtt', ext: 'vtt' }
    case 'md':
      return { text: toMarkdown(record, layer), mime: 'text/markdown', ext: 'md' }
    case 'json':
      return { text: JSON.stringify(record, null, 2), mime: 'application/json', ext: 'json' }
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}
