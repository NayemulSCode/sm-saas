/** Directory tables (migrations 0005, 0008). All tenant-owned, all RLS. */
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { localDate, ulidCol } from '../types';
import { tenantColumns } from './columns';


/**
 * A human, as known to ONE school. All personal data lives here, behind RLS —
 * which is the deliberate consequence of keeping `account` thin (§7.7).
 *
 * name_bn and name_en are BOTH real and both required: the report card prints
 * one, the board registration list needs the other, and neither is a
 * translation of the other (ADR-0019).
 */
export const person = pgTable('person', {
  ...tenantColumns<'person'>(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  dateOfBirth: localDate('date_of_birth'),
  gender: text('gender', { enum: ['male', 'female', 'other'] }),
  photoKey: text('photo_key'),
  /** CONTACT detail — deliberately NOT unique. The login identifier lives on
   *  credential.value and is globally unique. */
  phone: text('phone'),
  email: text('email'),
  birthRegNo: text('birth_reg_no'),
  address: jsonb('address').notNull().default({}),
  mergedIntoPersonId: ulidCol<'person'>('merged_into_person_id'),
});
