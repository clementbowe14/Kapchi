# GitHub Repository Governance

## Purpose

Kapchi is public so Vercel can build pull requests without private-repository collaborator grants. Public visibility does not grant write access. The `main` ruleset prevents direct pushes and requires a trusted repository collaborator to approve every pull request before merge.

GitHub counts a required approval only when the reviewer has write permission or higher. Reviews from unrelated public users do not satisfy the merge requirement.

## Required Main Rules

The reviewed contract is `deploy/github-main-ruleset.json`.

- Require every change to enter `main` through a pull request.
- Require one approval from a reviewer with write permission or higher.
- Dismiss approvals after new reviewable commits are pushed.
- Require someone other than the latest pusher to approve that push.
- Require all review conversations to be resolved.
- Do not grant bypass permission to users, repository roles, integrations, or deploy keys.
- Block force pushes and deletion of `main`.

## Public-Repository Activation

1. Change the repository visibility to public under **Settings > General > Danger Zone**.
2. Apply the reviewed contract from an authenticated administrator checkout:

   ```sh
   gh api --method POST repos/clementbowe14/Kapchi/rulesets \
     --header "X-GitHub-Api-Version: 2026-03-10" \
     --input deploy/github-main-ruleset.json
   ```

3. Open **Settings > Rules > Rulesets** and confirm `Protect main with trusted review` is active with no bypass actors.
4. Under **Settings > Moderation options > Code review limits**, enable **Limit to users explicitly granted read or higher access**. This keeps unrelated public users from submitting approval or request-changes reviews; the ruleset already prevents those reviews from satisfying the merge gate.
5. Run **Repository governance audit** from the Actions tab. The workflow validates the checked-in contract and the public live ruleset without repository secrets.

Do not add the governance audit as a required status check for pull requests. The native ruleset is the enforcement boundary; the workflow detects configuration drift after an administrator changes repository settings.

## Recovery

If a legitimate pull request is blocked, fix the review, unresolved conversation, or stale-approval state. Do not add a bypass actor. An administrator can edit the ruleset in an emergency, but must restore this exact contract immediately and run the governance audit afterward.
