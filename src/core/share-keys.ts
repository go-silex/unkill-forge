import { base64url } from 'jose'

const encoder = new TextEncoder()
const info = encoder.encode('forge:share-link:aes-gcm:v1')
const ivLength = 12
export const shareKeyMin = 16
export const shareKeyMax = 128

export function validShareKey(key: string) {
  return key.length >= shareKeyMin && key.length <= shareKeyMax && !/[^A-Za-z0-9_-]/.test(key)
}

export function generateShareKey() {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(16)))
}

async function sealingKey(secret: string) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function parameters(iv: Uint8Array<ArrayBuffer>, id: string, artefactId: string) {
  return { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([id, artefactId])) }
}

export async function sealShareKey(secret: string, id: string, artefactId: string, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const ciphertext = await crypto.subtle.encrypt(
    parameters(iv, id, artefactId),
    await sealingKey(secret),
    encoder.encode(key),
  )
  const bytes = new Uint8Array(ivLength + ciphertext.byteLength)
  bytes.set(iv)
  bytes.set(new Uint8Array(ciphertext), ivLength)
  return base64url.encode(bytes)
}

export async function unsealShareKey(secret: string, id: string, artefactId: string, sealed: string) {
  // The decoder allocates a fresh, non-shared buffer.
  const bytes = base64url.decode(sealed) as Uint8Array<ArrayBuffer>
  const plaintext = await crypto.subtle.decrypt(
    parameters(bytes.subarray(0, ivLength), id, artefactId),
    await sealingKey(secret),
    bytes.subarray(ivLength),
  )
  return new TextDecoder().decode(plaintext)
}
