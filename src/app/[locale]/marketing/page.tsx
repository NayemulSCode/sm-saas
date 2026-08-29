/**
 * Product marketing — sm.example.com. Sells the platform to schools.
 * Unauthenticated, cacheable, no tenant context.
 *
 * Pre-launch, and the copy says so. The roadmap puts the paid pilot at
 * Jun–Oct 2027 and commercial launch at Nov 2027 (§45.3) — nothing here
 * claims a feature is live before it is, and the CTA asks to talk, not to
 * "start a free trial" of a product that does not accept signups yet.
 *
 * Ships zero client JavaScript: nothing on this page needs it, and it is the
 * one route a stranger on any device, anywhere, loads cold (§4.4's marketing
 * budget is 180 KB, same as the staff app, for exactly that reason).
 *
 * The durable version of this page is a separate, later decision — the
 * roadmap names a CMS (Puck, §45.4) for the production marketing site once
 * there is a launch to run it for. This is that stub, done properly instead
 * of left as a placeholder, not the CMS build.
 */
import { buttonVariants, Badge, Card, CardContent } from '../../../components/ui';

const PAINS: Array<{ rank: string; title: string; body: string }> = [
  {
    rank: '০১',
    title: '"Who hasn’t paid?"',
    body: 'Arrears are tracked on a register or a spreadsheet, and they vanish when a student is promoted into next year’s sheet. One answer, across every year a student has been enrolled, is what makes an office trust the number on the screen instead of the one on paper.',
  },
  {
    rank: '০২',
    title: 'Result preparation',
    body: 'Tabulation done by hand takes days per exam, and an arithmetic slip surfaces in front of parents. Absent is tracked as absent, never quietly counted as zero — the one shortcut that makes a result sheet wrong in a way nobody catches until it is printed.',
  },
  {
    rank: '০৩',
    title: 'Telling parents things',
    body: 'SMS is the channel that actually reaches a guardian in Bangladesh. An absence alert or a result notice sent the same day is what "the school is organised" looks like from outside the office.',
  },
  {
    rank: '০৪',
    title: 'Attendance registers',
    body: 'Cheap to digitise, checked daily, and the number that feeds the two pains above it — arrears and results both start from who was actually there.',
  },
];

export default function MarketingPage(): React.JSX.Element {
  return (
    <main className="bg-[var(--color-surface)]">
      <div className="mx-auto max-w-5xl px-6 py-4">
        <span className="font-serif text-lg font-semibold text-[var(--color-text)]">স্কুল Suite</span>
      </div>

      {/* HERO */}
      <section className="mx-auto max-w-5xl px-6 pb-16 pt-10 sm:pb-24 sm:pt-16">
        <div className="grid gap-10 sm:grid-cols-[1.3fr_1fr] sm:items-end">
          <div>
            <Badge tone="brand">Building toward the 2027 school year</Badge>
            <h1 className="mt-5 font-serif text-4xl leading-tight text-[var(--color-text)] sm:text-5xl">
              The office register, made trustworthy — in Bangla and English, at once.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-[var(--color-text-muted)]">
              A school management system built around how a Bangladeshi school office actually
              works: fees that never lose an arrear, results that never round a hole in the data
              down to zero, and an SMS a guardian actually reads.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="mailto:hello@sm.example.com" className={buttonVariants({ size: 'lg' })}>
                Talk to us before admission season
              </a>
              <a href="#pains" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
                Why these four things
              </a>
            </div>
          </div>

          <Card className="shadow-[var(--shadow-md)]">
            <CardContent className="pt-5">
              <p className="text-sm text-[var(--color-text-muted)]">Not built by translating a system made for someone else’s school year</p>
              <dl className="mt-4 space-y-4">
                <div>
                  <dt className="text-sm text-[var(--color-text-muted)]">Names</dt>
                  <dd className="font-medium text-[var(--color-text)]">
                    <span lang="bn">নাম</span> and name, two real columns — neither a translation of the other
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-[var(--color-text-muted)]">Money</dt>
                  <dd className="font-medium text-[var(--color-text)]">Receipts numbered gaplessly, per school, per year</dd>
                </div>
                <div>
                  <dt className="text-sm text-[var(--color-text-muted)]">Absent</dt>
                  <dd className="font-medium text-[var(--color-text)]">Recorded as absent. Never quietly zero</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* THE FOUR PAINS */}
      <section id="pains" className="border-y border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <h2 className="font-serif text-2xl text-[var(--color-text)] sm:text-3xl">
            Four things make a principal change systems. We built for those first.
          </h2>
          <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
            Ranked by what actually gets a school to switch — not by what is easiest to build.
            A timetable or a library catalogue is not on this list, on purpose.
          </p>

          <ol className="mt-10 grid gap-8 sm:grid-cols-2">
            {PAINS.map((pain) => (
              <li key={pain.rank} className="flex gap-4">
                <span
                  className="font-serif text-3xl text-[var(--brand-accent)]"
                  aria-hidden="true"
                >
                  {pain.rank}
                </span>
                <div>
                  <h3 className="font-medium text-[var(--color-text)]">{pain.title}</h3>
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">{pain.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* CTA BAND */}
      <section className="bg-[var(--brand-primary)]">
        <div className="mx-auto flex max-w-5xl flex-col items-start gap-5 px-6 py-14 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-2xl text-[var(--brand-on-primary)]">
              A handful of schools will pilot fee collection and SMS in 2027.
            </h2>
            <p className="mt-2 text-[color-mix(in_srgb,var(--brand-on-primary)_85%,transparent)]">
              Tell us about your school and we will reach out when the pilot opens.
            </p>
          </div>
          <a
            href="mailto:hello@sm.example.com"
            className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'shrink-0' })}
          >
            hello@sm.example.com
          </a>
        </div>
      </section>

      <footer className="mx-auto max-w-5xl px-6 py-8 text-sm text-[var(--color-text-muted)]">
        Built in Bangladesh, for Bangladeshi schools.
      </footer>
    </main>
  );
}
