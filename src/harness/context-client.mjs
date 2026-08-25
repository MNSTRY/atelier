export const ATELIER_CONTEXT_SCHEMA = 'atelier-context@v1'
export const ATELIER_CAPABILITIES_SCHEMA = 'atelier-capabilities@v1'

function cleanBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:8137'))
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))) {
    throw new Error('Atelier harness baseUrl must be a local http sidecar URL')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}

export async function readJsonResponse(response, route) {
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${route} returned non-JSON response (${response.status})`)
  }
  if (!response.ok) {
    throw new Error(`${route} failed (${response.status}): ${body?.error || text}`)
  }
  return body
}

export async function jsonGet(baseUrl, route, params = null, headers = {}) {
  const base = cleanBaseUrl(baseUrl)
  const url = new URL(route, `${base.href}/`)
  if (params) appendParams(url, params)
  // @atelier-egress-local-computed
  const response = await fetch(url, {
    headers: {
      Origin: base.origin,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
  })
  return readJsonResponse(response, route)
}

export async function jsonPost(baseUrl, route, body = {}, headers = {}) {
  const base = cleanBaseUrl(baseUrl)
  const url = new URL(route, `${base.href}/`)
  // @atelier-egress-local-computed
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base.origin,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return readJsonResponse(response, route)
}

export async function requestSessionNonce(baseUrl, {
  sessionId,
  viewId,
  path = 'index.html',
  expectedWorkspaceId = null,
} = {}) {
  const body = await jsonGet(baseUrl, '/api/session-auth', {
    sessionId,
    viewId,
    path,
    expectedWorkspaceId,
  }, {
    Origin: cleanBaseUrl(baseUrl).origin,
    'Sec-Fetch-Site': 'same-origin',
  })
  if (!/^[a-f0-9]{64}$/.test(String(body.mutationNonce || ''))) {
    throw new Error('/api/session-auth did not return a mutation nonce')
  }
  return body
}

export function validateContextContract(body) {
  const errors = []
  if (body?.schema !== ATELIER_CONTEXT_SCHEMA) errors.push('context schema must be atelier-context@v1')
  if (body?.ok !== true) errors.push('context ok must be true')
  if (!body?.workspaceId || !/^[a-f0-9]{16}$/.test(String(body.workspaceId))) {
    errors.push('context must include a 16-character workspaceId')
  }
  if (!body?.origin) errors.push('context must include origin metadata')
  if (!body?.capabilities || body.capabilities.directWrite !== false) {
    errors.push('context capabilities must refuse direct writes')
  }
  if (body?.capabilities?.applyEndpoint != null) {
    errors.push('context capabilities must not expose an apply endpoint')
  }
  return errors
}

export function validateCapabilitiesContract(body) {
  const errors = []
  if (body?.schema !== ATELIER_CAPABILITIES_SCHEMA) errors.push('capabilities schema must be atelier-capabilities@v1')
  if (body?.ok !== true) errors.push('capabilities ok must be true')
  if (body?.directWrite !== false) errors.push('capabilities must refuse direct writes')
  if (body?.applyEndpoint != null) errors.push('capabilities must not expose an apply endpoint')
  const mutateIds = Array.isArray(body?.mutate) ? body.mutate.map((item) => item.id) : []
  if (mutateIds.some((id) => /apply|write|commit|persist|mutate/i.test(String(id)))) {
    errors.push('capabilities mutate list must not expose direct-write actions')
  }
  return errors
}

export async function atelierContextFlow(baseUrl, {
  sessionId = `atelier-session-${Date.now()}`,
  viewId = `atelier-view-${Date.now()}`,
  path = 'index.html',
  expectedWorkspaceId = null,
} = {}) {
  const health = await jsonGet(baseUrl, '/api/health')
  if (health.mutationNonce) throw new Error('/api/health must not expose mutationNonce')
  const workspaceId = expectedWorkspaceId || health.workspaceId
  const current = await jsonGet(baseUrl, '/api/current', { sessionId })
  const resolve = await jsonGet(baseUrl, '/api/resolve', { path })
  const doctor = await jsonGet(baseUrl, '/api/doctor')
  const capabilities = await jsonGet(baseUrl, '/api/capabilities')
  const capabilityErrors = validateCapabilitiesContract(capabilities)
  if (capabilityErrors.length) throw new Error(capabilityErrors.join('; '))
  const context = await jsonGet(baseUrl, '/api/context', {
    sessionId,
    viewId,
    path,
    expectedWorkspaceId: workspaceId,
  })
  const contextErrors = validateContextContract(context)
  if (contextErrors.length) throw new Error(contextErrors.join('; '))
  return {
    ok: true,
    health,
    current,
    resolve,
    doctor,
    capabilities,
    context,
  }
}
