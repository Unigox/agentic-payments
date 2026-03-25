#!/usr/bin/env -S node --experimental-strip-types
/**
 * Contact management CLI
 * Usage:
 *   manage-contacts.ts list
 *   manage-contacts.ts find <name>
 *   manage-contacts.ts add <key> <name> <aliases_comma_separated>
 *   manage-contacts.ts set-method <key> <currency> <method> <methodId> <networkId> [methodSlug] [network] [networkSlug] [selectedFormatId]
 *   manage-contacts.ts set-details <key> <currency> <json_details>
 *   manage-contacts.ts remove <key>
 */
import {
  loadContacts,
  saveContacts,
  ensureContact,
  resolveContact,
  removeContact,
} from "./contact-store.ts";

const [cmd, ...args] = process.argv.slice(2);
const store = loadContacts();

switch (cmd) {
  case "list": {
    for (const [key, contact] of Object.entries(store.contacts)) {
      const methods = Object.entries(contact.paymentMethods || {})
        .map(([currency, method]) => `${currency}:${method.method}${method.network ? `/${method.network}` : ""}`)
        .join(", ");
      console.log(`  ${key}: ${contact.name} [${contact.aliases?.join(", ") || ""}] methods: ${methods || "none"}`);
    }
    break;
  }

  case "find": {
    const match = resolveContact(store, args[0]);
    if (match) console.log(JSON.stringify({ key: match.key, ...match.contact }, null, 2));
    else console.log("Not found:", args[0]);
    break;
  }

  case "add": {
    const [key, name, aliasesStr] = args;
    if (!key || !name) {
      console.log("Usage: manage-contacts.ts add <key> <name> <aliases_comma_separated>");
      break;
    }
    ensureContact(store, {
      key,
      name,
      aliases: aliasesStr?.split(",").map((alias) => alias.trim()).filter(Boolean) || [],
    });
    saveContacts(store);
    console.log("Added:", key);
    break;
  }

  case "set-method": {
    const [key, currency, method, methodId, networkId, methodSlug, network, networkSlug, selectedFormatId] = args;
    const contact = store.contacts[key];
    if (!contact) {
      console.log("Contact not found:", key);
      break;
    }
    if (!contact.paymentMethods) contact.paymentMethods = {};
    contact.paymentMethods[currency.toUpperCase()] = {
      method,
      methodId: Number(methodId),
      methodSlug: methodSlug || undefined,
      networkId: Number(networkId),
      network: network || undefined,
      networkSlug: networkSlug || undefined,
      selectedFormatId: selectedFormatId || undefined,
      details: {},
    };
    saveContacts(store);
    console.log("Set method for", key, currency.toUpperCase());
    break;
  }

  case "set-details": {
    const [key, currency, jsonStr] = args;
    const paymentMethod = store.contacts[key]?.paymentMethods?.[currency.toUpperCase()];
    if (!paymentMethod) {
      console.log("Contact or currency not found");
      break;
    }
    paymentMethod.details = JSON.parse(jsonStr);
    saveContacts(store);
    console.log("Updated details for", key, currency.toUpperCase());
    break;
  }

  case "remove": {
    if (removeContact(store, args[0])) {
      saveContacts(store);
      console.log("Removed:", args[0]);
    } else {
      console.log("Contact not found:", args[0]);
    }
    break;
  }

  default:
    console.log("Usage: manage-contacts.ts <list|find|add|set-method|set-details|remove> [args]");
}
