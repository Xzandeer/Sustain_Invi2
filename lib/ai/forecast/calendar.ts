// Calendar context for the AI review of the 7-day forecast.
//
// The statistical forecast cannot see the calendar. These facts are passed to
// the language model so it has concrete, checkable reasons when it adjusts a
// day - and says so when there is none.
//
// Holidays: Philippine regular and special non-working days for 2026-2027 that
// fall on fixed or published dates. Holidays whose dates are proclaimed late
// (for example Eid al-Fitr) are not listed.

const HOLIDAYS: Record<string, string> = {
  // 2026
  '2026-01-01': "New Year's Day",
  '2026-02-17': 'Chinese New Year',
  '2026-02-25': 'EDSA Revolution Anniversary',
  '2026-04-02': 'Maundy Thursday',
  '2026-04-03': 'Good Friday',
  '2026-04-04': 'Black Saturday',
  '2026-04-09': 'Araw ng Kagitingan',
  '2026-05-01': 'Labor Day',
  '2026-06-12': 'Independence Day',
  '2026-08-21': 'Ninoy Aquino Day',
  '2026-08-31': 'National Heroes Day',
  '2026-11-01': "All Saints' Day",
  '2026-11-02': "All Souls' Day",
  '2026-11-30': 'Bonifacio Day',
  '2026-12-08': 'Feast of the Immaculate Conception',
  '2026-12-24': 'Christmas Eve',
  '2026-12-25': 'Christmas Day',
  '2026-12-30': 'Rizal Day',
  '2026-12-31': "New Year's Eve",
  // 2027
  '2027-01-01': "New Year's Day",
  '2027-02-06': 'Chinese New Year',
  '2027-02-25': 'EDSA Revolution Anniversary',
  '2027-03-25': 'Maundy Thursday',
  '2027-03-26': 'Good Friday',
  '2027-03-27': 'Black Saturday',
  '2027-04-09': 'Araw ng Kagitingan',
  '2027-05-01': 'Labor Day',
  '2027-06-12': 'Independence Day',
  '2027-08-21': 'Ninoy Aquino Day',
  '2027-08-30': 'National Heroes Day',
  '2027-11-01': "All Saints' Day",
  '2027-11-02': "All Souls' Day",
  '2027-11-30': 'Bonifacio Day',
  '2027-12-08': 'Feast of the Immaculate Conception',
  '2027-12-24': 'Christmas Eve',
  '2027-12-25': 'Christmas Day',
  '2027-12-30': 'Rizal Day',
  '2027-12-31': "New Year's Eve",
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface DayContext {
  date: string
  weekday: string
  payday: boolean
  holiday: string | null
}

/** Weekday, payday (15th and last day of the month) and holiday for YYYY-MM-DD. */
export function describeDay(dateKey: string): DayContext {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return {
    date: dateKey,
    weekday: WEEKDAYS[date.getUTCDay()],
    payday: d === 15 || d === lastDay,
    holiday: HOLIDAYS[dateKey] ?? null,
  }
}
