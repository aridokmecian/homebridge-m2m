import { ZoneServiceType } from "./types";

// The panel returns zone names in ALL CAPS with a leading zone number and irregular internal
// spacing (e.g. "12 East Wing    MOTIONs"). Strip the number, collapse spacing, and title-case.
export function normalizeZoneName(raw: string): string {
    const titleCased = raw
        .trim()
        .replace(/^\d+\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

    // HAP requires the name to start and end with a letter or number (punctuation like "(spare)"
    // is fine in the middle, just not at either edge) - trim anything else off both ends.
    return titleCased.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Keyword matching runs against the raw (pre-normalized) name, uppercased, so it isn't affected
// by capitalization.
export function zoneServiceTypeForName(rawName: string): ZoneServiceType {
    const upper = rawName.toUpperCase();
    if (upper.includes('DOOR') || upper.includes('SLIDER')) return ZoneServiceType.CONTACT;
    if (upper.includes('WINDOW') || upper.includes('GLASS')) return ZoneServiceType.CONTACT;
    if (upper.includes('MOTION')) return ZoneServiceType.MOTION;
    return ZoneServiceType.CONTACT;
}
