# Automated-use policy

The repository owner requests **no automated crawling or scraping** of this project. Obtain prior written permission from the owner before using its content for AI systems, including training, fine-tuning, evaluation, model inputs, dataset creation, data collection, or other automated reuse. Direct permission requests to the repository owner.

This request covers the project's source, documentation, assets, and deployed pages. Authorized users may still operate the add-on and connect their own authorized playlists.

## Robots requests and access controls

The supplied robots files request that every crawler avoid every path:

```text
User-agent: *
Disallow: /
```

These are advisory instructions for cooperating clients. They cannot technically prevent scraping, AI use, or indexing by clients that ignore them. Robots rules neither grant nor restrict access to credentials or private endpoints; existing authentication and hosting access controls remain responsible for that protection. See the [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html) and [Google's explanation of robots.txt limitations](https://developers.google.com/search/docs/crawling-indexing/robots/intro).

## Where a robots file applies

Serve the intended rules at `/robots.txt` at the root of each deployed website's origin. A copy stored only inside a repository or a project subdirectory is not the origin's authoritative robots file.

A repository-level `robots.txt` cannot control crawling of `github.com` or GitHub's raw-content hosts. Those hosts control their own origin-root robots policies.

GitHub Pages project sites share an origin. For projects under `dev1niscool.github.io`, the authoritative location is `https://dev1niscool.github.io/robots.txt`. Publishing that file requires configuring the account-level Pages site in the `dev1niscool.github.io` repository; adding a project's `docs/robots.txt` alone does not do this. These files do not create or configure that additional repository.

## Existing license

The existing [MIT license](LICENSE) remains unchanged. This document and robots comments express the owner's requested conduct; they do not amend, revoke, or add conditions to permissions granted by that license.
