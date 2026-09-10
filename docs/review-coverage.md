# Review coverage and incomplete results

A completed job is not necessarily a complete PR assessment. Octopus records which changed text hunks it actually supplied to the reviewer, separately from findings and quality scores.

## Standard review input

The reviewer enumerates provider file metadata before allocating its model-input budget. GitHub file pagination is independent of the raw diff ceiling, so a large early fixture cannot erase the paths or patches of later source files. GitLab diff metadata and Bitbucket diffstat are paginated too. The provider revision is checked before and after fetching; changed head/base revisions abort the attempt instead of mixing input revisions.

Source, configuration and package/build scripts have priority over test fixtures and documentation. Whole files that fit are supplied first; remaining space can contain complete hunks from a larger file. There is no character cut through a hunk. File and hunk digests and ranges are retained in the coverage manifest. Each supplied hunk records `sha256` over its exact emitted text (including its hunk header and normalized trailing newline); `suppliedSha256` hashes the entire emitted file section, while `patchSha256` hashes the original provider patch. Provider patch omissions and mismatched hunk/change counts stay explicit.

Existing `.octopusignore` exclusions are recorded as repository policy. Curated default generated-file exclusions remain explicit. A repository's additional generated labels cannot silently hide source, tests, schemas or configuration; those remain accounted for. Excluded files are not claimed as reviewed.

## Results and history

Coverage states are `supplied`, `partial`, `omitted`, `excluded`, and `unavailable`. The manifest also records expected/known file counts, pagination completeness, provider, head/base SHAs and limitations. `supplied` means all known changed text hunks were included in model input; it is not a guarantee that the model found every defect.

If a required file/hunk or part of the inventory is unavailable, the report says **Review incomplete**, omits the overall quality score, and the native check fails even when zero blocking findings were found. Severity thresholds still govern findings for fully covered reviews. Useful findings from incomplete reviews remain visible. This changes the result of an incomplete review; it does not change GitHub branch protection settings.

A completed large-review worker result currently carries prose without an independently verified file inventory. Its coverage is therefore unknown and cannot produce a passing complete-review check. The queued request carries `attemptId`, pinned `headSha` and `baseSha`, and the original `checkRunId`. The result producer must echo these fields unchanged in both success and error payloads; that external producer is not included in this repository. The consumer archives legacy results lacking identity without promoting the current report or touching a check. Correlated delayed results complete only their original check and cannot replace a newer head's report. This release does not change the worker's activation setting or pretend its prose proves coverage.

Each finalized attempt has an append-only `ReviewAttempt` record. The current PR view and mutable GitHub progress comment may change on a retry, while previous attempt records remain available. Saving an older head preserves its attempt without replacing the newer head's current report. The report links to `/api/review-attempts/:id`, which returns the complete manifest and final report as a JSON download. Access requires an active membership in the repository's organization or that organization's API token. Authentication, account-hold responses and tenant filtering apply; downloads are private and uncached. Repository/organization removal follows the existing cascading deletion policy.

Apply the `20260910223000_review_coverage_attempts` database migration before deploying the application. No migration is executed by a review request.

## Author comments and source supplements

The trigger comment is sent once as untrusted context, outside system instructions. The receipt records received/supplied character counts and any truncation. Source excerpts and claimed hashes in comments are not independently verified and do not add changed-hunk coverage. This fixes duplicated 59k-character supplements and makes the current trust boundary explicit; it does not establish a new verified-source upload protocol.

## Limits and follow-up work

This change keeps one main model review within the existing `MAX_DIFF_CHARS` budget (default 300,000). It does not add automatic multi-pass model calls, an unbounded retrieval loop or a model fallback. Provider pagination and retained patches are bounded. Remaining material produces an honest incomplete result.

Further work can add bounded multi-pass scheduling and verified source-supplement retrieval on top of this coverage contract. Those features must merge coverage only for exact-revision, actually supplied hunks; summaries, generated labels and unverified comments must never turn missing source into complete coverage.

The original Maestro #801 regression is verified privately against immutable evidence; the public test uses a synthetic 203-file contract case so private source is not copied into this repository. The tests exercise provider pagination, emitted model input, hunk budgeting, score/check outputs, append-only attempt storage and the actual authenticated retrieval handler.
