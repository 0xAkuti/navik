/** localStorage that tolerates sandboxed contexts (contract-hosted apps often run in opaque origins). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable: the list is just not remembered
    }
  },
}
