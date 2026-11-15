/**
 * Reference data for timezone resolution: country calling codes, country -> IANA
 * zones, NANP non-US/Canada area codes, US/Canadian/Australian regions, and common
 * country-name aliases.
 *
 * Multi-zone countries list every zone a lead could plausibly be in. When only the
 * country is known, the validator requires the outbound window to be open in *all*
 * of them (the conservative intersection), so it never dispatches early in one zone
 * just because it's open in another.
 */

/** Country calling code -> ISO 3166-1 alpha-2. Shared codes map to the main country; +1 is NANP. */
export const CALLING_CODES = {
  1: 'NANP', 7: 'RU', 20: 'EG', 27: 'ZA', 30: 'GR', 31: 'NL', 32: 'BE', 33: 'FR', 34: 'ES', 36: 'HU', 39: 'IT', 40: 'RO',
  41: 'CH', 43: 'AT', 44: 'GB', 45: 'DK', 46: 'SE', 47: 'NO', 48: 'PL', 49: 'DE', 51: 'PE', 52: 'MX', 53: 'CU', 54: 'AR',
  55: 'BR', 56: 'CL', 57: 'CO', 58: 'VE', 60: 'MY', 61: 'AU', 62: 'ID', 63: 'PH', 64: 'NZ', 65: 'SG', 66: 'TH', 81: 'JP',
  82: 'KR', 84: 'VN', 86: 'CN', 90: 'TR', 91: 'IN', 92: 'PK', 93: 'AF', 94: 'LK', 95: 'MM', 98: 'IR', 211: 'SS', 212: 'MA',
  213: 'DZ', 216: 'TN', 218: 'LY', 220: 'GM', 221: 'SN', 223: 'ML', 224: 'GN', 225: 'CI', 226: 'BF', 227: 'NE', 228: 'TG',
  229: 'BJ', 230: 'MU', 231: 'LR', 232: 'SL', 233: 'GH', 234: 'NG', 235: 'TD', 236: 'CF', 237: 'CM', 238: 'CV', 240: 'GQ',
  241: 'GA', 242: 'CG', 243: 'CD', 244: 'AO', 248: 'SC', 249: 'SD', 250: 'RW', 251: 'ET', 252: 'SO', 253: 'DJ', 254: 'KE',
  255: 'TZ', 256: 'UG', 257: 'BI', 258: 'MZ', 260: 'ZM', 261: 'MG', 263: 'ZW', 264: 'NA', 265: 'MW', 266: 'LS', 267: 'BW',
  268: 'SZ', 290: 'SH', 297: 'AW', 298: 'FO', 299: 'GL', 350: 'GI', 351: 'PT', 352: 'LU', 353: 'IE', 354: 'IS', 355: 'AL',
  356: 'MT', 357: 'CY', 358: 'FI', 359: 'BG', 370: 'LT', 371: 'LV', 372: 'EE', 373: 'MD', 374: 'AM', 375: 'BY', 376: 'AD',
  377: 'MC', 378: 'SM', 380: 'UA', 381: 'RS', 382: 'ME', 383: 'XK', 385: 'HR', 386: 'SI', 387: 'BA', 389: 'MK', 420: 'CZ',
  421: 'SK', 423: 'LI', 501: 'BZ', 502: 'GT', 503: 'SV', 504: 'HN', 505: 'NI', 506: 'CR', 507: 'PA', 509: 'HT', 591: 'BO',
  592: 'GY', 593: 'EC', 595: 'PY', 597: 'SR', 598: 'UY', 673: 'BN', 675: 'PG', 679: 'FJ', 852: 'HK', 853: 'MO', 855: 'KH',
  856: 'LA', 880: 'BD', 886: 'TW', 960: 'MV', 961: 'LB', 962: 'JO', 963: 'SY', 964: 'IQ', 965: 'KW', 966: 'SA', 967: 'YE',
  968: 'OM', 970: 'PS', 971: 'AE', 972: 'IL', 973: 'BH', 974: 'QA', 975: 'BT', 976: 'MN', 977: 'NP', 992: 'TJ', 993: 'TM',
  994: 'AZ', 995: 'GE', 996: 'KG', 998: 'UZ',
};

/** NANP area codes outside the US and Canada, plus US non-contiguous areas. */
export const NANP_SPECIAL_AREA_CODES = {
  242: 'America/Nassau', 246: 'America/Barbados', 264: 'America/Anguilla', 268: 'America/Antigua', 284: 'America/Tortola',
  340: 'America/St_Thomas', 345: 'America/Cayman', 441: 'Atlantic/Bermuda', 473: 'America/Grenada', 649: 'America/Grand_Turk',
  658: 'America/Jamaica', 664: 'America/Montserrat', 670: 'Pacific/Saipan', 671: 'Pacific/Guam', 684: 'Pacific/Pago_Pago',
  721: 'America/Lower_Princes', 758: 'America/St_Lucia', 767: 'America/Dominica', 784: 'America/St_Vincent',
  787: 'America/Puerto_Rico', 939: 'America/Puerto_Rico', 809: 'America/Santo_Domingo', 829: 'America/Santo_Domingo',
  849: 'America/Santo_Domingo', 868: 'America/Port_of_Spain', 869: 'America/St_Kitts', 876: 'America/Jamaica',
  808: 'Pacific/Honolulu', 907: 'America/Anchorage',
};

/** Contiguous US + main Canadian zones: the conservative set for a +1 number with no other signal. */
export const NANP_MAINLAND_ZONES = [
  'America/Halifax', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
];

export const MULTI_ZONE_COUNTRIES = {
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'],
  CA: ['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Regina', 'America/Edmonton', 'America/Vancouver'],
  MX: ['America/Cancun', 'America/Mexico_City', 'America/Mazatlan', 'America/Tijuana'],
  BR: ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco'],
  AU: ['Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth'],
  RU: ['Europe/Kaliningrad', 'Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Vladivostok'],
  ID: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'],
  CD: ['Africa/Kinshasa', 'Africa/Lubumbashi'],
  MN: ['Asia/Ulaanbaatar', 'Asia/Hovd'],
  ES: ['Europe/Madrid', 'Atlantic/Canary'],
  PT: ['Europe/Lisbon', 'Atlantic/Azores'],
  CL: ['America/Santiago', 'America/Punta_Arenas'],
  EC: ['America/Guayaquil', 'Pacific/Galapagos'],
  GL: ['America/Nuuk', 'America/Scoresbysund', 'America/Danmarkshavn'],
  KI: ['Pacific/Tarawa', 'Pacific/Kanton', 'Pacific/Kiritimati'],
  PF: ['Pacific/Tahiti', 'Pacific/Marquesas', 'Pacific/Gambier'],
};

export const SINGLE_ZONE_COUNTRIES = {
  AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul', AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AO: 'Africa/Luanda',
  AR: 'America/Argentina/Buenos_Aires', AT: 'Europe/Vienna', AW: 'America/Aruba', AZ: 'Asia/Baku', BA: 'Europe/Sarajevo',
  BD: 'Asia/Dhaka', BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia', BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura',
  BJ: 'Africa/Porto-Novo', BN: 'Asia/Brunei', BO: 'America/La_Paz', BT: 'Asia/Thimphu', BW: 'Africa/Gaborone', BY: 'Europe/Minsk',
  BZ: 'America/Belize', CF: 'Africa/Bangui', CG: 'Africa/Brazzaville', CH: 'Europe/Zurich', CI: 'Africa/Abidjan', CM: 'Africa/Douala',
  CN: 'Asia/Shanghai', CO: 'America/Bogota', CR: 'America/Costa_Rica', CU: 'America/Havana', CV: 'Atlantic/Cape_Verde',
  CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DE: 'Europe/Berlin', DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen', DZ: 'Africa/Algiers',
  EE: 'Europe/Tallinn', EG: 'Africa/Cairo', ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FO: 'Atlantic/Faroe',
  FR: 'Europe/Paris', GA: 'Africa/Libreville', GB: 'Europe/London', GE: 'Asia/Tbilisi', GH: 'Africa/Accra', GI: 'Europe/Gibraltar',
  GM: 'Africa/Banjul', GN: 'Africa/Conakry', GQ: 'Africa/Malabo', GR: 'Europe/Athens', GT: 'America/Guatemala', GY: 'America/Guyana',
  HK: 'Asia/Hong_Kong', HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince', HU: 'Europe/Budapest',
  IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome', JO: 'Asia/Amman', JP: 'Asia/Tokyo', KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh',
  KR: 'Asia/Seoul', KW: 'Asia/Kuwait', KZ: 'Asia/Almaty', LA: 'Asia/Vientiane', LB: 'Asia/Beirut', LI: 'Europe/Vaduz',
  LK: 'Asia/Colombo', LR: 'Africa/Monrovia', LS: 'Africa/Maseru', LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga',
  LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', MC: 'Europe/Monaco', MD: 'Europe/Chisinau', ME: 'Europe/Podgorica',
  MG: 'Indian/Antananarivo', MK: 'Europe/Skopje', ML: 'Africa/Bamako', MM: 'Asia/Yangon', MO: 'Asia/Macau', MT: 'Europe/Malta',
  MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MY: 'Asia/Kuala_Lumpur', MZ: 'Africa/Maputo',
  NA: 'Africa/Windhoek', NE: 'Africa/Niamey', NG: 'Africa/Lagos', NI: 'America/Managua', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo',
  NP: 'Asia/Kathmandu', NZ: 'Pacific/Auckland', OM: 'Asia/Muscat', PA: 'America/Panama', PE: 'America/Lima', PG: 'Pacific/Port_Moresby',
  PH: 'Asia/Manila', PK: 'Asia/Karachi', PL: 'Europe/Warsaw', PR: 'America/Puerto_Rico', PS: 'Asia/Hebron', PY: 'America/Asuncion',
  QA: 'Asia/Qatar', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RW: 'Africa/Kigali', SA: 'Asia/Riyadh', SC: 'Indian/Mahe',
  SD: 'Africa/Khartoum', SE: 'Europe/Stockholm', SG: 'Asia/Singapore', SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino', SN: 'Africa/Dakar', SO: 'Africa/Mogadishu',
  SR: 'America/Paramaribo', SS: 'Africa/Juba', SV: 'America/El_Salvador', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
  TD: 'Africa/Ndjamena', TG: 'Africa/Lome', TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe', TM: 'Asia/Ashgabat', TN: 'Africa/Tunis',
  TR: 'Europe/Istanbul', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam', UA: 'Europe/Kyiv', UG: 'Africa/Kampala',
  UY: 'America/Montevideo', UZ: 'Asia/Tashkent', VE: 'America/Caracas', VN: 'Asia/Ho_Chi_Minh', XK: 'Europe/Belgrade',
  YE: 'Asia/Aden', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare',
};

/** Region -> candidate zones. Split states list every zone used inside them. */
export const REGION_ZONES = {
  US: {
    AL: ['America/Chicago'], AK: ['America/Anchorage'], AZ: ['America/Phoenix'], AR: ['America/Chicago'], CA: ['America/Los_Angeles'],
    CO: ['America/Denver'], CT: ['America/New_York'], DE: ['America/New_York'], DC: ['America/New_York'],
    FL: ['America/New_York', 'America/Chicago'], GA: ['America/New_York'], HI: ['Pacific/Honolulu'],
    ID: ['America/Boise', 'America/Los_Angeles'], IL: ['America/Chicago'], IN: ['America/New_York', 'America/Chicago'],
    IA: ['America/Chicago'], KS: ['America/Chicago', 'America/Denver'], KY: ['America/New_York', 'America/Chicago'],
    LA: ['America/Chicago'], ME: ['America/New_York'], MD: ['America/New_York'], MA: ['America/New_York'],
    MI: ['America/New_York', 'America/Chicago'], MN: ['America/Chicago'], MS: ['America/Chicago'], MO: ['America/Chicago'],
    MT: ['America/Denver'], NE: ['America/Chicago', 'America/Denver'], NV: ['America/Los_Angeles'], NH: ['America/New_York'],
    NJ: ['America/New_York'], NM: ['America/Denver'], NY: ['America/New_York'], NC: ['America/New_York'],
    ND: ['America/Chicago', 'America/Denver'], OH: ['America/New_York'], OK: ['America/Chicago'],
    OR: ['America/Los_Angeles', 'America/Boise'], PA: ['America/New_York'], RI: ['America/New_York'], SC: ['America/New_York'],
    SD: ['America/Chicago', 'America/Denver'], TN: ['America/New_York', 'America/Chicago'], TX: ['America/Chicago', 'America/Denver'],
    UT: ['America/Denver'], VT: ['America/New_York'], VA: ['America/New_York'], WA: ['America/Los_Angeles'], WV: ['America/New_York'],
    WI: ['America/Chicago'], WY: ['America/Denver'], PR: ['America/Puerto_Rico'],
  },
  CA: {
    AB: ['America/Edmonton'], BC: ['America/Vancouver', 'America/Edmonton'], MB: ['America/Winnipeg'], NB: ['America/Moncton'],
    NL: ['America/St_Johns', 'America/Halifax'], NS: ['America/Halifax'], ON: ['America/Toronto', 'America/Winnipeg'],
    PE: ['America/Halifax'], QC: ['America/Toronto'], SK: ['America/Regina'], NT: ['America/Yellowknife'],
    NU: ['America/Iqaluit', 'America/Winnipeg', 'America/Edmonton'], YT: ['America/Whitehorse'],
  },
  AU: {
    NSW: ['Australia/Sydney'], ACT: ['Australia/Sydney'], VIC: ['Australia/Melbourne'], QLD: ['Australia/Brisbane'],
    SA: ['Australia/Adelaide'], WA: ['Australia/Perth'], TAS: ['Australia/Hobart'], NT: ['Australia/Darwin'],
  },
};

export const REGION_NAME_ALIASES = {
  US: {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
    'district of columbia': 'DC', 'washington dc': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
    indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
    michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
    tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
    wyoming: 'WY', 'puerto rico': 'PR',
  },
  CA: {
    alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB', 'newfoundland and labrador': 'NL', newfoundland: 'NL',
    'nova scotia': 'NS', ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC', 'québec': 'QC', saskatchewan: 'SK',
    'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
  },
  AU: {
    'new south wales': 'NSW', 'australian capital territory': 'ACT', victoria: 'VIC', queensland: 'QLD', 'south australia': 'SA',
    'western australia': 'WA', tasmania: 'TAS', 'northern territory': 'NT',
  },
};

export const COUNTRY_NAME_ALIASES = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  canada: 'CA', australia: 'AU', germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', españa: 'ES', italy: 'IT',
  netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', belgium: 'BE', switzerland: 'CH', austria: 'AT', ireland: 'IE',
  portugal: 'PT', sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ',
  mexico: 'MX', méxico: 'MX', brazil: 'BR', brasil: 'BR', argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE',
  india: 'IN', china: 'CN', japan: 'JP', 'south korea': 'KR', korea: 'KR', singapore: 'SG', 'hong kong': 'HK', taiwan: 'TW',
  philippines: 'PH', indonesia: 'ID', malaysia: 'MY', thailand: 'TH', vietnam: 'VN', 'viet nam': 'VN', 'new zealand': 'NZ',
  'south africa': 'ZA', nigeria: 'NG', kenya: 'KE', egypt: 'EG', israel: 'IL', 'united arab emirates': 'AE', uae: 'AE',
  'saudi arabia': 'SA', turkey: 'TR', türkiye: 'TR', russia: 'RU', 'russian federation': 'RU', ukraine: 'UA', pakistan: 'PK',
  bangladesh: 'BD', 'sri lanka': 'LK', greece: 'GR', romania: 'RO', hungary: 'HU', bulgaria: 'BG', croatia: 'HR', serbia: 'RS',
};
