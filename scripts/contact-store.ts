#!/usr/bin/env -S node --experimental-strip-types
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SKILL_DIR = path.join(__dirname, "..");
export const DEFAULT_CONTACTS_FILE = path.join(SKILL_DIR, "contacts.json");

export interface StoredPaymentMethod {
  method: string;
  methodId: number;
  methodSlug?: string;
  networkId: number;
  network?: string;
  networkSlug?: string;
  selectedFormatId?: string;
  details: Record<string, string>;
  lastValidatedAt?: string;
}

export interface ContactRecord {
  name: string;
  aliases: string[];
  paymentMethods: Record<string, StoredPaymentMethod>;
  notes?: string;
}

export interface ContactStoreData {
  contacts: Record<string, ContactRecord>;
  _meta: {
    lastUpdated?: string;
  };
}

export interface ContactMatch {
  key: string;
  contact: ContactRecord;
  matchType: "key" | "name" | "alias";
}

export interface ContactResolution {
  match?: ContactMatch;
  ambiguous: ContactMatch[];
  matchedBy?: "exact" | "partial";
}

function baseStore(): ContactStoreData {
  return {
    contacts: {},
    _meta: { lastUpdated: "" },
  };
}

export function normalizeLookupValue(value: string | undefined | null): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeContactKey(value: string): string {
  return normalizeLookupValue(value).replace(/\s+/g, "-") || "contact";
}

function normalizeStore(data: any): ContactStoreData {
  const store = baseStore();
  const contacts = data?.contacts && typeof data.contacts === "object" ? data.contacts : {};

  for (const [key, rawContact] of Object.entries(contacts) as Array<[string, any]>) {
    if (!rawContact || typeof rawContact !== "object") continue;
    store.contacts[key] = {
      name: String(rawContact.name || key),
      aliases: Array.isArray(rawContact.aliases)
        ? rawContact.aliases.map((alias: unknown) => String(alias)).filter(Boolean)
        : [],
      paymentMethods: rawContact.paymentMethods && typeof rawContact.paymentMethods === "object"
        ? Object.fromEntries(
            Object.entries(rawContact.paymentMethods).map(([currency, method]: [string, any]) => [
              currency.toUpperCase(),
              {
                method: String(method?.method || method?.name || ""),
                methodId: Number(method?.methodId || 0),
                methodSlug: method?.methodSlug ? String(method.methodSlug) : undefined,
                networkId: Number(method?.networkId || 0),
                network: method?.network ? String(method.network) : undefined,
                networkSlug: method?.networkSlug ? String(method.networkSlug) : undefined,
                selectedFormatId: method?.selectedFormatId ? String(method.selectedFormatId) : undefined,
                details: method?.details && typeof method.details === "object"
                  ? Object.fromEntries(Object.entries(method.details).map(([field, value]) => [field, String(value)]))
                  : {},
                lastValidatedAt: method?.lastValidatedAt ? String(method.lastValidatedAt) : undefined,
              } satisfies StoredPaymentMethod,
            ])
          )
        : {},
      ...(rawContact.notes ? { notes: String(rawContact.notes) } : {}),
    };
  }

  store._meta = {
    lastUpdated: typeof data?._meta?.lastUpdated === "string" ? data._meta.lastUpdated : "",
  };

  return store;
}

export function loadContacts(filePath = DEFAULT_CONTACTS_FILE): ContactStoreData {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return baseStore();
  }
}

export function saveContacts(store: ContactStoreData, filePath = DEFAULT_CONTACTS_FILE): ContactStoreData {
  const normalized = normalizeStore(store);
  normalized._meta.lastUpdated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

function dedupeMatches(matches: ContactMatch[]): ContactMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.key)) return false;
    seen.add(match.key);
    return true;
  });
}

function isPartialLookupMatch(candidate: string, normalizedQuery: string): boolean {
  if (!candidate || normalizedQuery.length < 2) return false;
  return candidate.includes(normalizedQuery);
}

function collectExactMatches(store: ContactStoreData, normalizedQuery: string): ContactMatch[] {
  const matches: ContactMatch[] = [];

  for (const [key, contact] of Object.entries(store.contacts)) {
    if (normalizeLookupValue(key) === normalizedQuery) {
      matches.push({ key, contact, matchType: "key" });
    }
  }

  for (const [key, contact] of Object.entries(store.contacts)) {
    if (normalizeLookupValue(contact.name) === normalizedQuery) {
      matches.push({ key, contact, matchType: "name" });
    }
  }

  for (const [key, contact] of Object.entries(store.contacts)) {
    if ((contact.aliases || []).some((alias) => normalizeLookupValue(alias) === normalizedQuery)) {
      matches.push({ key, contact, matchType: "alias" });
    }
  }

  return dedupeMatches(matches);
}

function collectPartialMatches(store: ContactStoreData, normalizedQuery: string): ContactMatch[] {
  const matches: ContactMatch[] = [];

  for (const [key, contact] of Object.entries(store.contacts)) {
    if (isPartialLookupMatch(normalizeLookupValue(key), normalizedQuery)) {
      matches.push({ key, contact, matchType: "key" });
      continue;
    }
    if (isPartialLookupMatch(normalizeLookupValue(contact.name), normalizedQuery)) {
      matches.push({ key, contact, matchType: "name" });
      continue;
    }
    if ((contact.aliases || []).some((alias) => isPartialLookupMatch(normalizeLookupValue(alias), normalizedQuery))) {
      matches.push({ key, contact, matchType: "alias" });
    }
  }

  return dedupeMatches(matches);
}

export function resolveContactQuery(store: ContactStoreData, query: string | undefined | null): ContactResolution {
  const normalizedQuery = normalizeLookupValue(query);
  if (!normalizedQuery) return { ambiguous: [] };

  const exactMatches = collectExactMatches(store, normalizedQuery);
  if (exactMatches.length === 1) {
    return { match: exactMatches[0], ambiguous: [], matchedBy: "exact" };
  }
  if (exactMatches.length > 1) {
    return { ambiguous: exactMatches, matchedBy: "exact" };
  }

  const partialMatches = collectPartialMatches(store, normalizedQuery);
  if (partialMatches.length === 1) {
    return { match: partialMatches[0], ambiguous: [], matchedBy: "partial" };
  }
  if (partialMatches.length > 1) {
    return { ambiguous: partialMatches, matchedBy: "partial" };
  }

  return { ambiguous: [] };
}

export function resolveContact(store: ContactStoreData, query: string | undefined | null): ContactMatch | undefined {
  return resolveContactQuery(store, query).match;
}

export function ensureContact(
  store: ContactStoreData,
  input: {
    key?: string;
    name: string;
    aliases?: string[];
    notes?: string;
  }
): { key: string; contact: ContactRecord; created: boolean } {
  const key = normalizeContactKey(input.key || input.name);
  const existing = store.contacts[key];
  const aliases = Array.from(new Set([...(existing?.aliases || []), ...(input.aliases || [])].filter(Boolean)));

  const contact: ContactRecord = {
    name: input.name || existing?.name || key,
    aliases,
    paymentMethods: existing?.paymentMethods || {},
    ...(input.notes || existing?.notes ? { notes: input.notes || existing?.notes } : {}),
  };

  store.contacts[key] = contact;
  return { key, contact, created: !existing };
}

export function upsertContactPaymentMethod(
  store: ContactStoreData,
  input: {
    key?: string;
    name: string;
    aliases?: string[];
    currency: string;
    method: StoredPaymentMethod;
    notes?: string;
  }
): { key: string; contact: ContactRecord; created: boolean } {
  const ensured = ensureContact(store, {
    key: input.key,
    name: input.name,
    aliases: input.aliases,
    notes: input.notes,
  });

  ensured.contact.paymentMethods[input.currency.toUpperCase()] = {
    ...input.method,
    details: { ...input.method.details },
  };

  return ensured;
}

export function removeContact(store: ContactStoreData, key: string): boolean {
  if (!store.contacts[key]) return false;
  delete store.contacts[key];
  return true;
}
