/**
 * ============================================================================
 *  net/classify.ts — turning evidence into a device category
 * ============================================================================
 *
 *  Discovery rarely produces a device type directly. It produces a hostname,
 *  a MAC address, an SNMP sysDescr, a neighbour platform string and a list
 *  of interface names. This module turns that evidence into a category AND
 *  states how sure it is.
 *
 *  Rules that matter:
 *
 *    • Every verdict carries the evidence that produced it. The UI shows the
 *      reason next to the category, so an operator can judge the guess.
 *    • "unknown" is a legitimate answer. When the evidence is thin we say so
 *      instead of inventing a plausible-looking type.
 *    • Nothing here writes to the database — classification is a pure
 *      function so it can be unit tested and reused by the collector, the
 *      discovery engine and the setup wizard.
 * ============================================================================
 */

import type { Confidence, DeviceCategory } from "../types";

/** Everything the classifier is allowed to look at. */
export interface ClassificationInput {
  /** sysName / DHCP hostname / NetBIOS name. */
  hostname?: string | null;
  /** SNMP sysDescr. */
  systemDescription?: string | null;
  /** SNMP sysObjectID. */
  objectId?: string | null;
  /** MAC address of the management interface. */
  mac?: string | null;
  /** Interface names reported by the device. */
  interfaceNames?: string[];
  /** LLDP/CDP neighbour platform string ("cisco WS-C2960"). */
  neighborPlatform?: string | null;
  /** Number of physical interfaces the device exposes. */
  interfaceCount?: number | null;
  /** The category an administrator assigned by hand — never overridden. */
  lockedCategory?: DeviceCategory | null;
}

export interface Classification {
  category: DeviceCategory;
  confidence: Confidence;
  /** Human-readable justification. Shown verbatim in the device detail. */
  evidence: string;
}

/* ------------------------------------------------------------------ */
/* OUI table                                                           */
/* ------------------------------------------------------------------ */

/**
 * A deliberately small OUI table.
 *
 * This is NOT a complete IEEE registry — shipping one would bloat the
 * bundle. It covers the vendors that dominate small/medium estates, and an
 * unknown OUI simply contributes no evidence rather than a wrong guess.
 */
const OUI_VENDORS: Record<string, string> = {
  "00:00:0c": "Cisco",
  "00:00:ab": "Marvell",
  "00:01:6c": "Hewlett Packard",
  "00:1b:21": "Huawei",
  "00:1e:0f": "Cisco-Linksys",
  "00:23:68": "Cisco",
  "00:26:08": "Ruijie",
  "00:26:5a": "MikroTik",
  "00:50:56": "VMware",
  "00:60:35": "Merit",
  "04:ee:cd": "Huawei",
  "08:00:27": "Oracle VirtualBox",
  "18:b4:30": "Nest Labs",
  "1c:1b:0d": "Giga-Byte",
  "1c:1b:b5": "TP-Link",
  "1e:29:70": "Xiaomi",
  "24:4b:fe": "Ubiquiti Networks",
  "2c:27:d7": "Hewlett Packard",
  "34:85:18": "Raspberry Pi Foundation",
  "3c:1b:f8": "Huawei",
  "40:23:cd": "Tp-Link",
  "40:ae:30": "Huawei",
  "44:d9:e7": "Ubiquiti Networks",
  "48:8f:5a": "Ubiquiti Networks",
  "50:c7:bf": "TP-Link",
  "5c:cf:7f": "Espressif",
  "60:32:b1": "Liteon",
  "64:6d:ad": "Hewlett Packard",
  "68:d5:90": "Cameo",
  "70:1c:e7": "Shenzhen",
  "70:56:81": "Apple",
  "70:b5:e8": "NXP Semiconductors",
  "74:24:9f": "Tenda",
  "74:83:c2": "Raspberry Pi Trading",
  "76:64:31": "Samsung",
  "78:11:dc": "Ubiquiti Networks",
  "80:2a:a8": "Ubiquiti Networks",
  "84:7b:eb": "Livescribe",
  "84:94:59": "AMPAK Technology",
  "8c:85:90": "Apple",
  "90:9c:92": "Chengdu",
  "90:b7:90": "Asustek",
  "94:3c:c6": "Apple",
  "98:5c:ed": "Apple",
  "9e:02:3a": "Intel",
  "a0:36:9f": "TP-Link",
  "a4:2b:b0": "Apple",
  "a4:cf:12": "Espressif",
  "ac:84:c6": "TP-Link",
  "b0:83:fe": "Hewlett Packard",
  "b0:be:76": "TP-Link",
  "b4:fb:e4": "Ubiquiti Networks",
  "c0:25:e9": "TP-Link",
  "c4:12:fb": "Raisecom",
  "c8:3a:35": "TP-Link",
  "cc:32:e5": "Xiaomi",
  "d4:6a:a8": "Hewlett Packard",
  "d8:5d:4c": "TP-Link",
  "dc:4a:9e": "Intel",
  "dc:a6:32": "Raspberry Pi Trading",
  "e0:ca:3c": "TP-Link",
  "e4:5f:01": "Raspberry Pi Trading",
  "e8:a0:ed": "Liteon Technology",
  "e8:db:84": "Espressif",
  "ec:fa:bc": "Alps Electric",
  "f0:9f:c2": "Ubiquiti Networks",
  "f4:f2:6d": "TP-Link",
  "f8:0f:6d": "Huawei",
  "f8:ed:fc": "QNAP",
  "fc:06:8c": "Shenzhen Foscam",
  "fc:ec:da": "Ubiquiti Networks",
};

/**
 * The lookup table, normalised to upper case.
 *
 * The table above is written in the human-readable "AA:BB:CC" form, which
 * mixes cases ("00:00:0c", "a4:cf:12"). MAC addresses arrive in every case
 * convention there is, so the comparison is always made on the upper-case
 * form of both sides.
 */
const OUI_LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(OUI_VENDORS).map(([oui, vendor]) => [oui.toUpperCase(), vendor])
);

/** The vendor for a MAC address, or null when the OUI is not in the table. */
export function vendorFromMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length < 12) return null;
  // The table is keyed by the human-readable "AA:BB:CC" form, so the first
  // three octets are re-formatted before the lookup.
  const oui = `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`;
  return OUI_LOOKUP[oui] ?? null;
}

/* ------------------------------------------------------------------ */
/* Keyword rules                                                       */
/* ------------------------------------------------------------------ */

interface Rule {
  category: DeviceCategory;
  /** Matches anywhere in the haystack. */
  patterns: RegExp[];
  /** Confidence contributed by this rule. */
  confidence: Confidence;
}

/**
 * Keyword rules, most specific first.
 *
 * Order matters: "access point" must win over "point" and "gateway" over
 * "router" in a description that mentions both.
 */
const RULES: Rule[] = [
  {
    category: "access_point",
    patterns: [/\baccess[ _-]?point\b/i, /\bap\b/i, /\bwireless\b/i, /\bwifi\b/i, /\bwlan\b/i],
    confidence: "probable",
  },
  {
    category: "switch",
    patterns: [
      /\bswitch\b/i,
      /\bws-?c\d{3,}/i,
      /\bsg\d{3}\b/i,
      /\bsf\d{3}\b/i,
      /\bcat\d{3}\b/i,
      /\bex\d{3}\b/i,
      /\bds\d{3}\b/i,
      /\bgs\d{3}\b/i,
      /\bsr\d{3}\b/i,
      /\bnxe\b/i,
      /\bgsr\b/i,
      /\btl-?s\d{3,}/i,
      /\bjetstream\b/i,
      /\bsmart[ _-]?switch\b/i,
    ],
    confidence: "probable",
  },
  {
    category: "gateway",
    patterns: [/\bgateway\b/i, /\bgw\b/i, /\bmodem\b/i, /\bont\b/i],
    confidence: "probable",
  },
  {
    category: "router",
    patterns: [
      /\brouter\b/i,
      /\bedge\b/i,
      /\b\d{3}[-_]?asr\b/i,
      /\bISR\d{4}\b/i,
      /\bcrs\d{3}\b/i,
      /\bMX\d{3}\b/i,
      /\bRTX\d{3}\b/i,
      /\bTailscale\b/i,
      /\bOpenWrt\b/i,
      /\bMikroTik\b/i,
      /\bvyOS\b/i,
      /\bpfSense\b/i,
      /\bOPNsense\b/i,
    ],
    confidence: "probable",
  },
  {
    category: "printer",
    patterns: [/\bprinter\b/i, /\bprint\s?server\b/i, /\blaserjet\b/i, /\bdeskjet\b/i, /\bmultifunction\b/i],
    confidence: "probable",
  },
  {
    category: "nvr",
    patterns: [/\bnvr\b/i, /\bdvr\b/i, /\brecorder\b/i, /\bhikvision\b/i, /\bdahua\b/i, /\breolink\b/i, /\bamcrest\b/i],
    confidence: "probable",
  },
  {
    category: "camera",
    patterns: [/\bcamera\b/i, /\bcctv\b/i, /\bipcam\b/i, /\bdome\b/i, /\bbullet\s?cam\b/i, /\bfoscam\b/i, /\banpviz\b/i],
    confidence: "probable",
  },
  {
    category: "nas",
    patterns: [/\bnas\b/i, /\bsynology\b/i, /\bdiskstation\b/i, /\btruenas\b/i, /\bnetapp\b/i, /\bfreenas\b/i],
    confidence: "probable",
  },
  {
    category: "server",
    patterns: [/\bserver\b/i, /\bproxmox\b/i, /\besxi\b/i, /\bhyper-?v\b/i, /\bhost\b/i],
    confidence: "probable",
  },
  {
    category: "tablet",
    patterns: [/\bipad\b/i, /\btablet\b/i, /\bgalaxy[ _-]?tab\b/i, /\bpixel[ _-]?tab\b/i],
    confidence: "probable",
  },
  {
    category: "phone",
    patterns: [
      /\biphone\b/i,
      /\bgalaxy[ _-]?(s|a|note|fold|flip)\d*/i,
      /\bpixel\b/i,
      /\boneplus\b/i,
      /\bredmi\b/i,
      /\bxiaomi\b/i,
      /\bmoto\s?[a-z]\b/i,
      /\bandroid\b/i,
      /\bphone\b/i,
    ],
    confidence: "probable",
  },
  {
    category: "voip_phone",
    patterns: [/\bvoip\b/i, /\bpolycom\b/i, /\bcisco\s?ip\s?phone\b/i, /\bSIP\b/],
    confidence: "probable",
  },
  {
    category: "industrial",
    patterns: [/\bplc\b/i, /\bscada\b/i, /\bindustrial\b/i, /\bhmiserver\b/i, /\bsiemens\b/i, /\ballen\b/i],
    confidence: "probable",
  },
  {
    category: "laptop",
    patterns: [/\blaptop\b/i, /\bnotebook\b/i, /\bmacbook\b/i, /\bthinkpad\b/i, /\bchromebook\b/i],
    confidence: "probable",
  },
  {
    category: "desktop",
    patterns: [/\bdesktop\b/i, /\bworkstation\b/i, /\bpc\b/i, /\bi7-?desktop\b/i],
    confidence: "probable",
  },
  {
    category: "internet",
    patterns: [/\bstarlink\b/i, /\bfiber\b.*\b(modem|ont)\b/i, /\bdsl\b/i, /\bcable\s?modem\b/i, /\bisp\b/i],
    confidence: "probable",
  },
];

/** Category confidence order — the strongest match wins. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 3,
  probable: 2,
  unknown: 1,
};

/* ------------------------------------------------------------------ */
/* The classifier                                                      */
/* ------------------------------------------------------------------ */

/**
 * Classify a device from the evidence available.
 *
 * A locked (administrator-assigned) category is always honoured — the
 * classifier never second-guesses a human.
 */
export function classifyDevice(input: ClassificationInput): Classification {
  if (input.lockedCategory) {
    return {
      category: input.lockedCategory,
      confidence: "confirmed",
      evidence: "An administrator assigned this category by hand; discovery never overwrites it.",
    };
  }

  const hostname = (input.hostname ?? "").trim();
  const description = (input.systemDescription ?? "").trim();
  const platform = (input.neighborPlatform ?? "").trim();
  const vendor = vendorFromMac(input.mac);
  const interfaceNames = input.interfaceNames ?? [];
  const interfaceCount = input.interfaceCount ?? interfaceNames.length;

  // The haystack every keyword rule is matched against.
  const haystack = [hostname, description, platform].filter(Boolean).join(" — ");
  const evidence: string[] = [];

  let best: { category: DeviceCategory; confidence: Confidence; why: string } | null = null;

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(haystack);
      if (!match) continue;
      const why = `The name/description "${match[0]}" matches the ${rule.category} signature.`;
      if (
        !best ||
        CONFIDENCE_RANK[rule.confidence] > CONFIDENCE_RANK[best.confidence]
      ) {
        best = { category: rule.category, confidence: rule.confidence, why };
      }
      break; // one hit per rule is enough
    }
  }

  // Structural evidence: how many interfaces does it expose?
  const isSwitchLike =
    interfaceCount >= 8 &&
    interfaceNames.some((name) => /^(gigabitethernet|gi|te|eth|port|ethernet|sfp|xe)/i.test(name));

  if (isSwitchLike && (!best || best.category !== "switch")) {
    best = {
      category: "switch",
      confidence: "probable",
      why: `The device exposes ${interfaceCount} ethernet interfaces, which is typical of a switch.`,
    };
  }

  if (best) {
    evidence.push(best.why);
  }

  if (vendor) {
    evidence.push(`The MAC OUI belongs to ${vendor}.`);
  }

  // Ubiquiti devices are switches or access points depending on the model.
  if (vendor === "Ubiquiti Networks" && !best) {
    evidence.push(
      "The MAC OUI belongs to Ubiquiti Networks, but the model could not be determined — the category stays unknown."
    );
  }

  if (!best) {
    return {
      category: "unknown",
      confidence: "unknown",
      evidence:
        evidence.length > 0
          ? `${evidence.join(" ")} No category signature matched, so the device is left as unknown for an administrator to classify.`
          : "There was not enough evidence to classify this device. An administrator can set the category by hand.",
    };
  }

  // A known vendor + a matched signature upgrades the verdict to confirmed.
  let confidence = best.confidence;
  if (confidence === "probable" && vendor && matchesVendor(best.category, vendor)) {
    confidence = "confirmed";
    evidence.push(`${vendor} manufactures this device type, so the classification is confirmed.`);
  }

  return { category: best.category, confidence, evidence: evidence.join(" ") };
}

/** True when the OUI vendor is a plausible maker of the classified type. */
function matchesVendor(category: DeviceCategory, vendor: string): boolean {
  const v = vendor.toLowerCase();
  switch (category) {
    case "switch":
      return ["cisco", "ubiquiti", "netgear", "tp-link", "aruba", "hewlett", "juniper", "ruijie", "zyxel"].some(
        (needle) => v.includes(needle)
      );
    case "access_point":
      return ["ubiquiti", "cisco", "aruba", "hewlett", "tp-link", "meraki"].some((needle) => v.includes(needle));
    case "router":
      return ["cisco", "ubiquiti", "mikrotik", "tp-link", "netgear", "huawei", "juniper"].some((needle) =>
        v.includes(needle)
      );
    case "camera":
    case "nvr":
      return ["hikvision", "dahua", "axis", "uniview", "reolink"].some((needle) => v.includes(needle));
    case "printer":
      return ["hewlett", "canon", "brother", "lexmark", "epson", "xerox", "ricoh"].some((needle) =>
        v.includes(needle)
      );
    case "nas":
      return ["synology", "qnap", "western digital", "netapp"].some((needle) => v.includes(needle));
    default:
      return false;
  }
}

/**
 * A readable provisional name for a device that has no hostname.
 *
 * "74:24:9F:57:D9:91" tells nobody anything. The label is built from what was
 * actually observed — the category, the vendor read from the OUI, and the last
 * two octets of the MAC so two similar devices stay apart. When nothing at all
 * is known the address is used, which is at least true.
 */
export function suggestedName(input: {
  category?: DeviceCategory | null;
  manufacturer?: string | null;
  hostname?: string | null;
  mac?: string | null;
  ip?: string | null;
}): string | undefined {
  const hostname = input.hostname?.trim();
  if (hostname) return hostname;

  const hex = (input.mac ?? "").replace(/[^0-9a-fA-F]/g, "");
  const tail = hex.length >= 12 ? hex.slice(-4).toUpperCase() : "";
  const vendor = input.manufacturer?.trim();
  const category = input.category ?? "unknown";

  if (category !== "unknown") {
    const label = CATEGORY_LABELS[category];
    const suffix = tail ? ` ${tail}` : input.ip ? ` ${input.ip}` : "";
    return `${label}${vendor ? ` (${vendor})` : ""}${suffix}`;
  }
  if (vendor) return tail ? `${vendor} ${tail}` : `${vendor} device`;
  return input.ip ? `Device ${input.ip}` : undefined;
}

/**
 * A short, honest description of a category for the UI.
 */
export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  internet: "Internet source",
  router: "Router",
  gateway: "Gateway",
  switch: "Switch",
  desktop: "Desktop",
  laptop: "Laptop",
  phone: "Phone",
  tablet: "Tablet",
  printer: "Printer",
  server: "Server",
  nvr: "Network video recorder",
  camera: "Camera",
  access_point: "Access point",
  nas: "Network storage",
  voip_phone: "VoIP phone",
  industrial: "Industrial device",
  unknown: "Unclassified",
};
