// EVE Online Blueprint Categories
// bpId = the Blueprint item's type ID (used for Fuzzwork SDE lookup)
// iconId = the rendered SHIP/ITEM type ID (used for EVE image server icons)
// Icon URL: https://images.evetech.net/types/{iconId}/icon?size=32
// BP render: https://images.evetech.net/types/{bpId}/bp?size=32

const EVE_CATEGORIES = [
  {
    label: "CAPITAL SHIPS",
    icon: "🚀",
    items: [
      { name: "Nomad",       bpId: 28847, iconId: 28846 },
      { name: "Rhea",        bpId: 28849, iconId: 28848 },
      { name: "Anshar",      bpId: 28851, iconId: 28850 },
      { name: "Ark",         bpId: 28845, iconId: 28844 },
      { name: "Rorqual",     bpId: 28353, iconId: 28352 },
      { name: "Nyx",         bpId: 23913, iconId: 23757 },
      { name: "Aeon",        bpId: 23917, iconId: 23915 },
      { name: "Wyvern",      bpId: 23913, iconId: 23911 },
      { name: "Hel",         bpId: 22853, iconId: 22852 },
      { name: "Revelation",  bpId: 19721, iconId: 19720 },
      { name: "Moros",       bpId: 19723, iconId: 19722 },
      { name: "Naglfar",     bpId: 19725, iconId: 19724 },
      { name: "Phoenix",     bpId: 19727, iconId: 19726 },
      { name: "Archon",      bpId: 23758, iconId: 23757 },
      { name: "Chimera",     bpId: 23912, iconId: 23911 },
      { name: "Thanatos",    bpId: 23912, iconId: 23911 },
      { name: "Nidhoggur",   bpId: 22853, iconId: 22852 },
      { name: "Avatar",      bpId: 11568, iconId: 11567 },
      { name: "Erebus",      bpId: 672,   iconId: 671   },
      { name: "Leviathan",   bpId: 45650, iconId: 45649 },
      { name: "Ragnarok",    bpId: 3765,  iconId: 3764  },
    ]
  },
  {
    label: "FREIGHTERS",
    icon: "📦",
    items: [
      { name: "Obelisk",    bpId: 20188, iconId: 20187 },
      { name: "Providence", bpId: 20190, iconId: 20189 },
      { name: "Charon",     bpId: 20186, iconId: 20185 },
      { name: "Fenrir",     bpId: 20184, iconId: 20183 },
      { name: "Bowhead",    bpId: 37604, iconId: 37603 },
      { name: "Mastodon",   bpId: 28853, iconId: 28852 },
      { name: "Prowler",    bpId: 28855, iconId: 28854 },
      { name: "Viator",     bpId: 28857, iconId: 28856 },
      { name: "Crane",      bpId: 28859, iconId: 28858 },
    ]
  },
  {
    label: "BATTLESHIPS",
    icon: "⚔️",
    items: [
      { name: "Apocalypse",              bpId: 698,   iconId: 642   },
      { name: "Armageddon",              bpId: 700,   iconId: 643   },
      { name: "Abaddon",                 bpId: 24693, iconId: 24692 },
      { name: "Megathron",               bpId: 697,   iconId: 641   },
      { name: "Hyperion",                bpId: 24691, iconId: 24690 },
      { name: "Dominix",                 bpId: 701,   iconId: 645   },
      { name: "Maelstrom",               bpId: 24695, iconId: 24694 },
      { name: "Tempest",                 bpId: 695,   iconId: 639   },
      { name: "Typhoon",                 bpId: 700,   iconId: 644   },
      { name: "Scorpion",                bpId: 696,   iconId: 640   },
      { name: "Raven",                   bpId: 694,   iconId: 638   },
      { name: "Rokh",                    bpId: 24689, iconId: 24688 },
      { name: "Apocalypse Navy Issue",   bpId: 17727, iconId: 17726 },
      { name: "Megathron Navy Issue",    bpId: 17729, iconId: 17728 },
      { name: "Raven Navy Issue",        bpId: 17842, iconId: 17841 },
      { name: "Tempest Fleet Issue",     bpId: 17733, iconId: 17732 },
      { name: "Nightmare",               bpId: 17739, iconId: 17738 },
      { name: "Machariel",               bpId: 17741, iconId: 17740 },
      { name: "Vindicator",              bpId: 17921, iconId: 17920 },
      { name: "Bhaalgorn",               bpId: 17923, iconId: 17922 },
    ]
  },
  {
    label: "CRUISERS & BC",
    icon: "🛸",
    items: [
      { name: "Vagabond",   bpId: 11994, iconId: 11993 },
      { name: "Muninn",     bpId: 22453, iconId: 22452 },
      { name: "Deimos",     bpId: 22453, iconId: 22452 },
      { name: "Zealot",     bpId: 12004, iconId: 12003 },
      { name: "Cerberus",   bpId: 11994, iconId: 11993 },
      { name: "Sacrilege",  bpId: 22457, iconId: 22456 },
      { name: "Brutix",     bpId: 16230, iconId: 16229 },
      { name: "Myrmidon",   bpId: 16234, iconId: 16233 },
      { name: "Drake",      bpId: 24699, iconId: 24698 },
      { name: "Hurricane",  bpId: 24703, iconId: 24702 },
      { name: "Harbinger",  bpId: 24697, iconId: 24696 },
      { name: "Prophecy",   bpId: 20126, iconId: 20125 },
      { name: "Astarte",    bpId: 22469, iconId: 22468 },
      { name: "Absolution", bpId: 22471, iconId: 22470 },
    ]
  },
  {
    label: "STRUCTURES",
    icon: "🏗️",
    items: [
      { name: "Raitaru",             bpId: 35880, iconId: 35825 },
      { name: "Azbel",               bpId: 35881, iconId: 35826 },
      { name: "Sotiyo",              bpId: 35882, iconId: 35827 },
      { name: "Astrahus",            bpId: 35890, iconId: 35832 },
      { name: "Fortizar",            bpId: 35891, iconId: 35833 },
      { name: "Keepstar",            bpId: 35892, iconId: 35834 },
      { name: "Athanor",             bpId: 35893, iconId: 35835 },
      { name: "Tatara",              bpId: 35894, iconId: 35836 },
      { name: "Ansiblex Jump Gate",  bpId: 37853, iconId: 35841 },
    ]
  },
  {
    label: "CAPITAL COMPONENTS",
    icon: "⚙️",
    items: [
      { name: "Capital Jump Drive",                              bpId: 21010, iconId: 21009 },
      { name: "Capital Deflection Shield Emitter",               bpId: 21018, iconId: 21017 },
      { name: "Capital Electrolytic Capacitor Unit",             bpId: 21020, iconId: 21019 },
      { name: "Capital Fernite Carbide Composite Armor Plate",   bpId: 21022, iconId: 21021 },
      { name: "Capital Ladar Sensor Cluster",                    bpId: 21024, iconId: 21023 },
      { name: "Capital Nanomechanical Microprocessor",           bpId: 21026, iconId: 21025 },
      { name: "Capital Nuclear Reactor Unit",                    bpId: 21028, iconId: 21027 },
      { name: "Capital Plasma Thruster",                         bpId: 21030, iconId: 21029 },
      { name: "Capital Titanium Diborite Armor Plate",           bpId: 21032, iconId: 21031 },
      { name: "Capital Crystalline Carbonide Armor Plate",       bpId: 21034, iconId: 21033 },
    ]
  },
  {
    label: "FIGHTERS",
    icon: "✈️",
    items: [
      { name: "Einherji",  bpId: 32210, iconId: 32209 },
      { name: "Firbolg",   bpId: 32214, iconId: 32213 },
      { name: "Templar",   bpId: 32208, iconId: 32207 },
      { name: "Dragonfly", bpId: 32216, iconId: 32215 },
      { name: "Cyclops",   bpId: 32212, iconId: 32211 },
      { name: "Satyr",     bpId: 32218, iconId: 32217 },
      { name: "Mantis",    bpId: 40564, iconId: 40563 },
      { name: "Tyrfing",   bpId: 40562, iconId: 40561 },
      { name: "Gram",      bpId: 40566, iconId: 40565 },
    ]
  },
  {
    label: "MODULES — WEAPONS",
    icon: "🔫",
    items: [
      { name: "Tachyon Beam Laser II",        bpId: 20648, iconId: 20647 },
      { name: "Mega Pulse Laser II",           bpId: 20618, iconId: 20617 },
      { name: "800mm Repeating Cannon II",     bpId: 21505, iconId: 21504 },
      { name: "Cruise Missile Launcher II",    bpId: 21741, iconId: 21740 },
      { name: "Torpedo Launcher II",           bpId: 21741, iconId: 21740 },
      { name: "Neutron Blaster Cannon II",     bpId: 22964, iconId: 22963 },
    ]
  },
  {
    label: "MODULES — TANK",
    icon: "🛡️",
    items: [
      { name: "Damage Control II",                        bpId: 2049,  iconId: 2048  },
      { name: "Large Armor Repairer II",                  bpId: 3531,  iconId: 3530  },
      { name: "Shield Booster II",                        bpId: 3595,  iconId: 3594  },
      { name: "Invulnerability Field II",                 bpId: 11290, iconId: 11289 },
      { name: "Energized Adaptive Nano Membrane II",      bpId: 11270, iconId: 11269 },
      { name: "Armor Kinetic Hardener II",                bpId: 11832, iconId: 11831 },
    ]
  },
];

window.EVE_CATEGORIES = EVE_CATEGORIES;
