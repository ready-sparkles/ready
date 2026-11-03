import unittest
from datetime import datetime, timezone
from meeting_agent.clock_context import current_clock


class ClockContextTests(unittest.TestCase):
    def test_same_instant_has_different_local_dates(self):
        now = datetime(2026, 9, 25, 3, 30, tzinfo=timezone.utc)
        sf = current_clock('America/Los_Angeles', now=now)
        stockholm = current_clock('Europe/Stockholm', now=now)
        self.assertEqual((sf['today'], sf['tomorrow']), ('2026-09-24', '2026-09-25'))
        self.assertEqual((stockholm['today'], stockholm['tomorrow']), ('2026-09-25', '2026-09-26'))

    def test_dst_and_year_boundaries_use_calendar_days(self):
        for instant, tomorrow in [(datetime(2026, 11, 1, 8, 30, tzinfo=timezone.utc), '2026-11-02'),
                                  (datetime(2027, 1, 1, 3, tzinfo=timezone.utc), '2027-01-01')]:
            self.assertEqual(current_clock('America/Los_Angeles', now=instant)['tomorrow'], tomorrow)

    def test_invalid_zone_is_not_silently_treated_as_utc(self):
        self.assertEqual(current_clock('San Francisco')['error'], 'invalid_time_zone')
        with self.assertRaises(ValueError):
            current_clock(now=datetime(2026, 9, 24))
