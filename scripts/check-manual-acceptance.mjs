// Offline only. Reads a copied PR39 harness result; never fetches or writes data.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const CANDIDATE = 'bd9fe2107998d693a87578906962a520327fa85e';
export const CHECKS = ['legacyControlled','oldCacheRemoved','siblingCachePreserved','privateNotCached','candidateControlled','onlineSyntheticRead','networkProbeBlocked','offlineApiRejected','offlineShellAvailable'];
export function validate(value) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {result:'FAIL',issues:['結果必須是 JSON object']};
  if (value.fixture !== 'pr39-mobile-v1') issues.push('驗收工具版本不符');
  if (value.candidate !== CANDIDATE) issues.push('候選 commit 不符，不能沿用此結果');
  if (value.status !== 'PASS' || value.stage !== 'complete') issues.push('流程尚未完整通過');
  if (typeof value.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.runId)) issues.push('缺少有效 runId');
  if (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) issues.push('缺少完成時間');
  if (value.error != null) issues.push('結果仍含失敗狀態，須核對原始流程');
  for (const key of CHECKS) if (value.checks?.[key] !== true) issues.push('未通過：'+key);
  const iphone = typeof value.userAgent === 'string' && /iPhone/.test(value.userAgent);
  if (!iphone) issues.push('不是可識別的 iPhone 結果');
  return {result:issues.length ? 'FAIL' : 'SYNTHETIC_IPHONE_CHECKS_PASS',candidate:CANDIDATE,
    passedChecks:CHECKS.filter(key=>value.checks?.[key]===true).length,totalChecks:CHECKS.length,issues,
    installedPwa:'UNVERIFIED: v1 harness does not record standalone display mode',
    production:'NOT_TESTED',releaseAuthorization:'NOT_GRANTED'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('arguments');
    const result=validate(JSON.parse(readFileSync(process.argv[2] || 0,'utf8')));
    console.log(JSON.stringify(result,null,2));
    if (result.result==='FAIL') process.exitCode=1;
  } catch {
    console.error('無法讀取驗收 JSON。只提供結果檔路徑，或將原始結果從 stdin 輸入。');
    process.exitCode=1;
  }
}
