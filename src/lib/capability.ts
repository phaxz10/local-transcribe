import type {
  CapabilityReport,
  CapabilityTier,
  CatalogModel,
  EngineDevice,
} from './types'

async function detectWebGPU(): Promise<{ available: boolean; f16: boolean }> {
  try {
    const gpu = (
      navigator as unknown as {
        gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> }
      }
    ).gpu
    if (!gpu) return { available: false, f16: false }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { available: false, f16: false }
    return { available: true, f16: Boolean(adapter.features?.has('shader-f16')) }
  } catch {
    return { available: false, f16: false }
  }
}

function detectSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
        1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    )
  } catch {
    return false
  }
}

function detectMobile(): boolean {
  const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } })
    .userAgentData
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

async function storageEstimate(): Promise<{ quotaMb: number | null; usageMb: number | null }> {
  try {
    if (navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate()
      return {
        quotaMb: quota != null ? Math.round(quota / 1e6) : null,
        usageMb: usage != null ? Math.round(usage / 1e6) : null,
      }
    }
  } catch {
    /* ignore */
  }
  return { quotaMb: null, usageMb: null }
}

export async function detectCapability(): Promise<CapabilityReport> {
  const cores = navigator.hardwareConcurrency || 4
  const deviceMemoryGb =
    (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null
  const mobile = detectMobile()
  const gpu = await detectWebGPU()
  // The fp16 weights we ship for WebGPU need `shader-f16`; without it session creation fails after
  // the download and we'd fetch the WASM variant too, so treat such an adapter as WASM up front.
  const webgpu = gpu.available && gpu.f16
  const device: EngineDevice = webgpu ? 'webgpu' : 'wasm'
  const coi = Boolean(globalThis.crossOriginIsolated)
  const threads = typeof SharedArrayBuffer !== 'undefined' && coi
  const simd = detectSimd()
  const { quotaMb, usageMb } = await storageEstimate()

  let score = Math.min(cores, 16) / 4
  if (deviceMemoryGb) score += Math.min(deviceMemoryGb, 16) / 4
  else score += mobile ? 1 : 2
  if (mobile) score -= 1.5
  if (webgpu) score += 2.5 // WebGPU is the big multiplier

  const tier: CapabilityTier = score >= 6 ? 'high' : score >= 3.5 ? 'medium' : 'low'

  return {
    tier,
    cores,
    deviceMemoryGb,
    mobile,
    crossOriginIsolated: coi,
    webgpu,
    webgpuF16: gpu.f16,
    device,
    threads,
    simd,
    storageQuotaMb: quotaMb,
    storageUsageMb: usageMb,
    benchmarkRtf: null,
  }
}

export interface FitResult {
  supported: boolean
  reason?: string
}

/** The one hard block: WebGPU requirement + storage headroom (ADR-0003). */
export function fitCheck(model: CatalogModel, cap: CapabilityReport): FitResult {
  if (model.requiresWebGPU && !cap.webgpu) {
    return {
      supported: false,
      reason: 'This model needs WebGPU, which is not available in this browser.',
    }
  }
  const sizeMb = (cap.device === 'wasm' && model.sizeMbWasm) || model.sizeMb
  if (cap.storageQuotaMb != null && cap.storageUsageMb != null && sizeMb > 0) {
    const free = cap.storageQuotaMb - cap.storageUsageMb
    if (free < sizeMb * 1.3) {
      return { supported: false, reason: `Not enough free storage (~${sizeMb} MB needed).` }
    }
  }
  return { supported: true }
}

export function estimateEta(durationSec: number, rtf: number | null): number | null {
  if (!rtf || rtf <= 0) return null
  return durationSec / rtf
}
