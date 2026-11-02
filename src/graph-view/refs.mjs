// The qualified identity is supplied by the source owner; never title-derived.
export const refKey = ref => JSON.stringify([ref.repoId, ref.localId])
