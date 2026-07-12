---
# ---------------------------------------------------------------------------
# Job-search scoring criteria — starter template.
#
# Copy this file to the path referenced by your module config `criteria`
# (default: career/opportunities/search-criteria.md) and edit the `scoring`
# block below to describe the roles you care about. The keyword lists here are
# NEUTRAL EXAMPLES — replace them with your own.
#
# `jobs score` reads this frontmatter, scores every job, and the breakdown it
# stores is keyed by YOUR group names. A job's total is the sum of every
# group's points + the location dimension + the compensation dimension.
# ---------------------------------------------------------------------------
scoring:
  # Each group contributes up to `weight` points. Give it a short kebab-case
  # `name` — that name becomes a key in every job's score breakdown.
  groups:
    - name: distributed-systems
      weight: 25
      # match: all (default) scans title + description + tags + location.
      # `tiers` are graded keyword lists, strongest first; the best matching
      # tier wins (points are NOT summed across tiers).
      tiers:
        - points: 25
          keywords: [distributed systems, consensus, raft, event sourcing]
        - points: 15
          keywords: [scalability, high availability, fault tolerance]
        - points: 8
          keywords: [microservices, kubernetes, message queue]

    - name: seniority
      weight: 15
      match: title            # only look at the job title for this group
      # A flat `keywords` list (no tiers) scores the full `weight` on any match.
      keywords: [staff, principal, architect, lead, head of, director]

    - name: infrastructure
      weight: 10
      # `titleBoost` multiplies a tier's points when a keyword hit the title
      # (rewards title matches over body-only mentions). Default 1.0.
      titleBoost: 1.2
      keywords: [terraform, aws, gcp, azure, docker, ci/cd, observability]

  # Location dimension. `excluded` markers zero it out; `preferred` markers
  # award the full `weight`. Markers are matched on word boundaries, so short
  # tokens like "eu" / "uk" won't match inside other words ("Milwaukee").
  location:
    weight: 20
    preferred: [remote, worldwide, anywhere, europe, emea]
    excluded: [us only, united states only, must reside in the us, on-site]

  # Titles that hard-disqualify a posting (whole job scores 0).
  excludeTitles: [sales, marketing, recruiter, account executive]

  # Optional compensation dimension. Benchmark is in EUR minor units (cents),
  # annual — job salaries are normalized to EUR cents on ingest. A job at or
  # above the benchmark scores the full `compensationWeight`; at >= 80% it
  # scores half; unknown salary scores ~30% (so it isn't penalized).
  compensationBenchmark: 15000000
  compensationWeight: 10

  # Classification thresholds: score >= queueThreshold => queued for review;
  # score < dismissThreshold => auto-dismissed.
  queueThreshold: 60
  dismissThreshold: 35
---

# Job-search criteria

Human-readable notes about what you're looking for live in the body of this
file. Only the `scoring:` frontmatter above drives `jobs score`; this prose is
for you (and any agent helping you triage).
