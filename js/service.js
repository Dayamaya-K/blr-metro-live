"use strict";
// BMRCL service pattern (approximation of the published timetable, Aug 2026).
// All times are IST wall-clock. Bands: [from, to, headway minutes] — trains
// depart BOTH terminals at this interval within the band. Tune freely.
//
// Sources: BMRCL announcements & press coverage — peak ~5 min on Purple/Green,
// Yellow Line ~7 min peak after the 2026 fleet additions. First trains 05:00
// (Sundays 07:00), last around 23:00.

const SERVICE = {
  timezone: "Asia/Kolkata",
  lines: {
    purple: {
      // Whitefield (Kadugodi) <-> Challaghatta, ~43.5 km
      endToEndMin: 78,
      dwellSec: 25,
      days: {
        weekday: [
          ["05:00", "07:00", 10],
          ["07:00", "11:00", 5],
          ["11:00", "16:30", 8],
          ["16:30", "20:30", 5],
          ["20:30", "23:05", 10],
        ],
        saturday: [
          ["05:00", "07:00", 10],
          ["07:00", "21:00", 6],
          ["21:00", "23:05", 10],
        ],
        sunday: [
          ["07:00", "21:00", 8],
          ["21:00", "23:00", 10],
        ],
      },
    },
    green: {
      // Madavara <-> Silk Institute, ~33.9 km
      endToEndMin: 62,
      dwellSec: 25,
      days: {
        weekday: [
          ["05:00", "07:00", 10],
          ["07:00", "11:00", 5],
          ["11:00", "16:30", 8],
          ["16:30", "20:30", 5],
          ["20:30", "23:05", 10],
        ],
        saturday: [
          ["05:00", "07:00", 10],
          ["07:00", "21:00", 7],
          ["21:00", "23:05", 10],
        ],
        sunday: [
          ["07:00", "21:00", 8],
          ["21:00", "23:00", 10],
        ],
      },
    },
    yellow: {
      // RV Road <-> Bommasandra, ~19 km
      endToEndMin: 34,
      dwellSec: 25,
      days: {
        weekday: [
          ["05:00", "07:00", 12],
          ["07:00", "11:00", 7],
          ["11:00", "17:00", 11],
          ["17:00", "20:30", 7],
          ["20:30", "23:00", 12],
        ],
        saturday: [
          ["05:00", "07:00", 12],
          ["07:00", "21:00", 9],
          ["21:00", "23:00", 12],
        ],
        sunday: [
          ["07:00", "21:00", 12],
          ["21:00", "23:00", 14],
        ],
      },
    },
  },
};
