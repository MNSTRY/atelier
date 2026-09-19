// Every refusal of the maintenance runtime is this one typed error. `code` is
// the stable, machine-readable reason; `detail` never carries note bytes.
export class ObsidianMaintenanceRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'ObsidianMaintenanceRefusal'
    this.code = code
    this.detail = detail
  }
}

export function refuse(code, message, detail) {
  throw new ObsidianMaintenanceRefusal(code, message, detail)
}
