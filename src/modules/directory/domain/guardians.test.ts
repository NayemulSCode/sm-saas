import { describe, it, expect } from 'vitest';
import {
  evaluateLink,
  evaluateUnlink,
  recipientsFor,
  type ExistingLink,
  type Relationship,
} from './guardians';

const link = (
  id: string,
  guardianPersonId: string,
  over: Partial<ExistingLink> = {},
): ExistingLink => ({
  id,
  guardianPersonId,
  relationship: 'guardian',
  isBillingGuardian: false,
  isPrimaryContact: false,
  canReceiveResults: true,
  canCollectStudent: true,
  ...over,
});

const proposed = (
  guardianPersonId: string,
  over: Partial<{ relationship: Relationship; billing: boolean; primary: boolean }> = {},
) => ({
  guardianPersonId,
  relationship: over.relationship ?? ('father' as Relationship),
  isBillingGuardian: over.billing ?? false,
  isPrimaryContact: over.primary ?? false,
});

describe('linking a guardian', () => {
  it('links the first guardian with no demotion needed', () => {
    const v = evaluateLink([], proposed('g1', { billing: true, primary: true }));
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') return;
    expect(v.demoteBilling).toBeNull();
    expect(v.demotePrimary).toBeNull();
  });

  it('refuses the same guardian twice', () => {
    expect(evaluateLink([link('l1', 'g1')], proposed('g1')).kind).toBe('already_linked');
  });

  /*
   * The separated-parent case the whole module exists for: the father pays and
   * the mother is contacted. Neither flag implies the other.
   */
  it('lets one parent bill while the other is the contact', () => {
    const existing = [link('l1', 'father', { isBillingGuardian: true })];
    const v = evaluateLink(existing, proposed('mother', { relationship: 'mother', primary: true }));

    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') return;
    // The father keeps billing; only the primary-contact flag is being claimed.
    expect(v.demoteBilling).toBeNull();
    expect(v.demotePrimary).toBeNull();
  });

  describe('at most one of each', () => {
    it('names the incumbent billing guardian to demote', () => {
      const existing = [link('l1', 'g1', { isBillingGuardian: true })];
      const v = evaluateLink(existing, proposed('g2', { billing: true }));
      expect(v.kind).toBe('ok');
      if (v.kind === 'ok') expect(v.demoteBilling).toBe('l1');
    });

    it('names the incumbent primary contact to demote', () => {
      const existing = [link('l1', 'g1', { isPrimaryContact: true })];
      const v = evaluateLink(existing, proposed('g2', { primary: true }));
      expect(v.kind).toBe('ok');
      if (v.kind === 'ok') expect(v.demotePrimary).toBe('l1');
    });

    it('can demote two different people at once', () => {
      const existing = [
        link('l1', 'g1', { isBillingGuardian: true }),
        link('l2', 'g2', { isPrimaryContact: true }),
      ];
      const v = evaluateLink(existing, proposed('g3', { billing: true, primary: true }));
      expect(v.kind).toBe('ok');
      if (v.kind !== 'ok') return;
      expect(v.demoteBilling).toBe('l1');
      expect(v.demotePrimary).toBe('l2');
    });

    it('demotes nobody when the new link claims neither flag', () => {
      const existing = [link('l1', 'g1', { isBillingGuardian: true, isPrimaryContact: true })];
      const v = evaluateLink(existing, proposed('g2'));
      expect(v.kind).toBe('ok');
      if (v.kind !== 'ok') return;
      expect(v.demoteBilling).toBeNull();
      expect(v.demotePrimary).toBeNull();
    });
  });

  /*
   * An emergency contact is the number you ring when nobody else answers. They
   * have not agreed to pay fees, and an invoice addressed to a neighbour is
   * almost always a data-entry slip rather than an intention.
   */
  it('refuses to bill an emergency contact', () => {
    expect(
      evaluateLink([], proposed('g1', { relationship: 'emergency', billing: true })).kind,
    ).toBe('emergency_cannot_bill');
  });

  it('still allows an emergency contact who bills nothing', () => {
    expect(evaluateLink([], proposed('g1', { relationship: 'emergency' })).kind).toBe('ok');
  });
});

describe('unlinking a guardian', () => {
  it('unlinks one of several', () => {
    const existing = [link('l1', 'g1', { isBillingGuardian: true }), link('l2', 'g2')];
    expect(evaluateUnlink(existing, 'g2').kind).toBe('ok');
  });

  it('reports a guardian who was never linked', () => {
    expect(evaluateUnlink([link('l1', 'g1')], 'nobody').kind).toBe('not_linked');
  });

  /*
   * A student with no contactable guardian is unreachable: no absence SMS, no
   * result notification, nobody to call when they are ill. The consequence
   * appears weeks later and looks like the SMS system being broken, so this is
   * refused rather than warned about.
   */
  it('refuses to remove the last guardian', () => {
    expect(evaluateUnlink([link('l1', 'g1')], 'g1').kind).toBe('last_contact');
  });

  it('refuses to leave a student with nobody to invoice', () => {
    const existing = [link('l1', 'g1', { isBillingGuardian: true }), link('l2', 'g2')];
    expect(evaluateUnlink(existing, 'g1').kind).toBe('would_leave_no_biller');
  });

  it('allows it once someone else bills', () => {
    const existing = [
      link('l1', 'g1', { isBillingGuardian: true }),
      link('l2', 'g2', { isBillingGuardian: false }),
      link('l3', 'g3', { isBillingGuardian: false }),
    ];
    // g2 does not bill, so removing them leaves g1 in place.
    expect(evaluateUnlink(existing, 'g2').kind).toBe('ok');
  });
});

describe('recipientsFor', () => {
  const withPhone = (id: string, phone: string | null, suppressed = false) => ({
    ...link(`l-${id}`, id),
    phone,
    suppressed,
  });

  /*
   * FR-9.4. Two absent siblings sharing one handset must produce ONE message:
   * a family that receives two identical SMS stops reading them, and each one
   * is billed.
   */
  it('deduplicates a shared handset', () => {
    const r = recipientsFor([
      withPhone('mother', '+8801711223344'),
      withPhone('father', '+8801711223344'),
    ]);
    expect(r).toEqual(['+8801711223344']);
  });

  it('keeps genuinely different numbers', () => {
    expect(recipientsFor([withPhone('a', '+880171'), withPhone('b', '+880172')])).toHaveLength(2);
  });

  // FR-4.10 — suppressing a guardian from receiving messages.
  it('drops a suppressed guardian', () => {
    expect(recipientsFor([withPhone('a', '+880171', true), withPhone('b', '+880172')])).toEqual([
      '+880172',
    ]);
  });

  it('drops a guardian with no phone rather than sending to nothing', () => {
    expect(recipientsFor([withPhone('a', null), withPhone('b', '+880172')])).toEqual(['+880172']);
  });

  it('returns nothing when nobody is reachable', () => {
    expect(recipientsFor([withPhone('a', null), withPhone('b', '+880172', true)])).toEqual([]);
  });
});
