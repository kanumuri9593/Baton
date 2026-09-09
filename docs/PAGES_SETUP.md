# GitHub Pages Setup

This site deploys automatically via GitHub Actions when changes are pushed to `master`.

## One-Time Setup (Repository Owner)

To enable GitHub Pages for this repository:

1. Go to **Settings** → **Pages** in the repository
2. Under **Source**, select **GitHub Actions**
3. The workflow at `.github/workflows/pages.yml` will handle deployments

Alternatively, using the GitHub CLI:

```bash
gh api repos/{owner}/{repo}/pages \
  -X POST \
  -f build_type=workflow
```

## What Gets Deployed

The workflow:
1. Copies `docs/` as the site root
2. Copies SVG assets from `assets/` to `docs/assets/`
3. Deploys to `https://{owner}.github.io/{repo}/`

## Local Preview

To preview the site locally:

```bash
cd docs
python3 -m http.server 8000
# Open http://localhost:8000
```

Or with Node:

```bash
npx serve docs
```

## Site Structure

```
docs/
├── index.html        # Landing page
├── roi.html          # ROI scenarios (case studies)
├── assets/
│   └── style.css     # Site styles
└── PAGES_SETUP.md    # This file (not published)
```

## Updating Content

- Edit `docs/index.html` for the main landing page
- Edit `docs/roi.html` for ROI/case study scenarios
- Edit `docs/assets/style.css` for styling
- Edit `assets/*.svg` for brand assets (copied during deploy)

Changes pushed to `master` trigger automatic deployment.
