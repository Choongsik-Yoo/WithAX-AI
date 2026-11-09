import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export async function purgeExpiredEvidence(db) {
  const now = Date.now();
  const cycles = await db.collection('cycles').where('status','==','closed').get();
  for (const cycle of cycles.docs) {
    const data = cycle.data();
    if (data.evidencePurgedAt || !data.settingsVersion) continue;
    const version = (await db.collection('settingsVersions').doc(data.settingsVersion).get()).data();
    const years = version?.snapshot.retentionYears;
    const closed = data.closedAt?.toDate() ?? new Date(data.schedule.close + 'T23:59:59+09:00');
    if (!Number.isInteger(years) || years < 1 || !Number.isFinite(closed.getTime())) continue;
    closed.setUTCFullYear(closed.getUTCFullYear() + years);
    if (closed.getTime() > now) continue;
    const cases = db.collection('cases').where('cycleId','==',cycle.id);
    while (true) {
      const page = await cases.limit(300).get();
      if (page.empty) break;
      const batch = db.batch();
      for (const doc of page.docs) batch.delete(doc.ref);
      await batch.commit();
    }
    const results = await db.collection('evaluations').where('cycleId','==',cycle.id).get();
    for (const row of results.docs) {
      const item = row.data();
      const scrub = indicators => indicators.map(({ reason, evidence, ...value }) => value);
      const patch = {};
      if (item.aiDraft) patch.aiDraft = FieldValue.delete();
      if (item.review) patch.review = { gate: item.review.gate, indicators: scrub(item.review.indicators) };
      if (item.final) patch['final.indicators'] = scrub(item.final.indicators);
      if (Object.keys(patch).length) await row.ref.update(patch);
    }
    await cycle.ref.update({ evidencePurgedAt: Timestamp.fromMillis(now) });
  }
}
