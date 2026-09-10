import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { TranscriptRecord } from './types'

export interface RecordingChunk {
  sessionId: string
  seq: number
  pcm: Int16Array
}

export interface MediaAsset {
  id: string
  blob: Blob
  filename: string
  mimeType: string
  sizeBytes: number
  createdAt: number
}

interface LTDB extends DBSchema {
  transcripts: {
    key: string
    value: TranscriptRecord
    indexes: { 'by-updated': number }
  }
  media: {
    key: string
    value: MediaAsset
  }
  settings: { key: string; value: unknown }
  /** In-flight Live Session audio, appended every ~5 s so a crash can be recovered on boot. */
  recordingChunks: {
    key: [string, number]
    value: RecordingChunk
  }
}

let dbp: Promise<IDBPDatabase<LTDB>> | null = null

function db(): Promise<IDBPDatabase<LTDB>> {
  if (!dbp) {
    dbp = openDB<LTDB>('local-transcribe', 3, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const t = d.createObjectStore('transcripts', { keyPath: 'id' })
          t.createIndex('by-updated', 'updatedAt')
          d.createObjectStore('settings')
        }
        if (oldVersion < 2) {
          d.createObjectStore('media', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          d.createObjectStore('recordingChunks', { keyPath: ['sessionId', 'seq'] })
        }
      },
    })
  }
  return dbp
}

export async function saveTranscript(r: TranscriptRecord): Promise<void> {
  await (await db()).put('transcripts', r)
}

export async function getTranscript(id: string): Promise<TranscriptRecord | undefined> {
  return (await db()).get('transcripts', id)
}

export async function listTranscripts(): Promise<TranscriptRecord[]> {
  const all = await (await db()).getAllFromIndex('transcripts', 'by-updated')
  return all.reverse() // newest first
}

export async function deleteTranscript(id: string): Promise<void> {
  const d = await db()
  const rec = await d.get('transcripts', id)
  await d.delete('transcripts', id)
  const mediaId = rec?.source.mediaId
  if (!mediaId) return
  const remaining = await d.getAll('transcripts')
  if (!remaining.some((r) => r.source.mediaId === mediaId)) {
    await d.delete('media', mediaId)
  }
}

export async function saveMediaAsset(asset: MediaAsset): Promise<void> {
  await (await db()).put('media', asset)
}

export async function getMediaAsset(id: string): Promise<MediaAsset | undefined> {
  return (await db()).get('media', id)
}

export async function putRecordingChunk(chunk: RecordingChunk): Promise<void> {
  await (await db()).put('recordingChunks', chunk)
}

/** Every persisted chunk of a session, in seq order. */
export async function getRecordingChunks(sessionId: string): Promise<Int16Array[]> {
  const all = await (await db()).getAll(
    'recordingChunks',
    IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]),
  )
  return all.sort((a, b) => a.seq - b.seq).map((c) => c.pcm)
}

export async function deleteRecordingChunks(sessionId: string): Promise<void> {
  await (await db()).delete(
    'recordingChunks',
    IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]),
  )
}

/** Distinct session ids with persisted chunks, i.e. recordings that never got finalised. */
export async function listRecordingSessionIds(): Promise<string[]> {
  const keys = await (await db()).getAllKeys('recordingChunks')
  return [...new Set(keys.map((k) => k[0]))]
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db()).get('settings', key) as Promise<T | undefined>
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', value, key)
}

/** Wipe ALL local data: our history/settings, the engine's cached models, and Cache Storage. */
export async function wipeEverything(): Promise<void> {
  const d = await db()
  await d.clear('transcripts')
  await d.clear('media')
  await d.clear('settings')
  await d.clear('recordingChunks')
  try {
    indexedDB.deleteDatabase('whisper-web')
  } catch {
    /* ignore */
  }
  try {
    if ('caches' in window) {
      for (const k of await caches.keys()) await caches.delete(k)
    }
  } catch {
    /* ignore */
  }
}
