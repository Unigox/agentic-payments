#!/usr/bin/env -S node --experimental-strip-types
/**
 * Contact management CLI
 * Usage:
 *   manage-contacts.ts list
 *   manage-contacts.ts find <name>
 *   manage-contacts.ts add <key> <name> <aliases_comma_separated>
 *   manage-contacts.ts set-method <key> <currency> <method> <methodId> <networkId>
 *   manage-contacts.ts set-details <key> <currency> <json_details>
 *   manage-contacts.ts remove <key>
 */
import fs from "fs";
import path from "path";

const CONTACTS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "contacts.json");

function load() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8")); }
  catch { return { contacts: {}, _meta: {} }; }
}

function save(data: any) {
  data._meta = { ...data._meta, lastUpdated: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2) + "\n");
}

const [cmd, ...args] = process.argv.slice(2);
const store = load();

switch (cmd) {
  case "list":
    for (const [k, v] of Object.entries(store.contacts) as any[]) {
      const methods = Object.keys(v.paymentMethods || {}).join(", ");
      console.log(`  ${k}: ${v.name} [${v.aliases?.join(", ")}] methods: ${methods || "none"}`);
    }
    break;

  case "find": {
    const q = args[0]?.toLowerCase();
    const found = Object.entries(store.contacts).find(([k, v]: any) =>
      k.toLowerCase() === q || v.name?.toLowerCase() === q || v.aliases?.some((a: string) => a.toLowerCase() === q)
    );
    if (found) console.log(JSON.stringify(found[1], null, 2));
    else console.log("Not found:", args[0]);
    break;
  }

  case "add": {
    const [key, name, aliasesStr] = args;
    store.contacts[key] = { name, aliases: aliasesStr?.split(",") || [], paymentMethods: {} };
    save(store);
    console.log("Added:", key);
    break;
  }

  case "set-method": {
    const [key, currency, method, methodId, networkId] = args;
    if (!store.contacts[key]) { console.log("Contact not found:", key); break; }
    if (!store.contacts[key].paymentMethods) store.contacts[key].paymentMethods = {};
    store.contacts[key].paymentMethods[currency] = {
      method, methodId: Number(methodId), networkId: Number(networkId), details: {},
    };
    save(store);
    console.log("Set method for", key, currency);
    break;
  }

  case "set-details": {
    const [key, currency, jsonStr] = args;
    if (!store.contacts[key]?.paymentMethods?.[currency]) {
      console.log("Contact or currency not found"); break;
    }
    store.contacts[key].paymentMethods[currency].details = JSON.parse(jsonStr);
    save(store);
    console.log("Updated details for", key, currency);
    break;
  }

  case "remove": {
    delete store.contacts[args[0]];
    save(store);
    console.log("Removed:", args[0]);
    break;
  }

  default:
    console.log("Usage: manage-contacts.ts <list|find|add|set-method|set-details|remove> [args]");
}
