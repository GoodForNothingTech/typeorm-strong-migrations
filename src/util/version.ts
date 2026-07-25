/** Numeric parts of a version string, ignoring any suffix such as "-MariaDB". */
export function versionParts(version: string): number[] {
    const match = /^\D*(\d+(?:\.\d+)*)/.exec(version.trim())
    if (!match) return []
    return match[1]!.split(".").map((part) => Number.parseInt(part, 10))
}

export function compareVersions(a: string, b: string): number {
    const left = versionParts(a)
    const right = versionParts(b)
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
        const l = left[index] ?? 0
        const r = right[index] ?? 0
        if (l !== r) return l < r ? -1 : 1
    }
    return 0
}

export function atLeast(version: string | undefined, minimum: string): boolean {
    if (!version) return false
    return compareVersions(version, minimum) >= 0
}

export function below(version: string | undefined, ceiling: string): boolean {
    if (!version) return false
    return compareVersions(version, ceiling) < 0
}

/** MariaDB reports e.g. "10.11.6-MariaDB-1:10.11.6+maria~ubu2204". */
export function isMariaDbVersion(version: string | undefined): boolean {
    return !!version && /mariadb/i.test(version)
}
