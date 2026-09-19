# Pardeh — setup guide

This is the real, deployable version of the demo site: a small static site
(built with Eleventy) plus a free, password-protected admin panel (Decap CMS)
so you can add news, add shows, and edit the page text yourself — no code.

## What's inside

- `content/news/*.md` — one file per news article
- `content/shows/*.md` — one file per upcoming show
- `_data/site.json` — all the other page text (hero, about, footer, etc.)
- `admin/` — the content-editing panel, served at `yoursite.com/admin`
- `css/`, `js/` — the design and language-toggle logic
- `index.njk` — the page template that pulls all of the above together

You will never need to open any of these by hand once the admin panel is
live — this is just so you know what's there.

## One-time setup (about 10 minutes)

**1. Push this folder to a new GitHub repository.**
Create an empty repo (e.g. `pardeh-site`) on GitHub, then from inside this
folder:

```
git init
git add .
git commit -m "Initial site"
git branch -M main
git remote add origin https://github.com/<your-username>/pardeh-site.git
git push -u origin main
```

**2. Connect it to Netlify.**
On [netlify.com](https://www.netlify.com), choose "Add new site" → "Import
an existing project" → pick this GitHub repo. Netlify will detect the build
settings from `netlify.toml` automatically (build command `npm run build`,
publish folder `_site`). Click deploy — your site goes live on a
`*.netlify.app` address (you can add your real domain later in Netlify's
domain settings).

**3. Turn on the admin login.**
In the Netlify dashboard for this site: go to **Site configuration → Identity**
and click **Enable Identity**. Then go to **Identity → Services** and enable
**Git Gateway**. Finally, under Identity, click **Invite users** and invite
your own email — you'll get an email link to set a password.

That's it. From then on, go to `yoursite.netlify.app/admin`, log in with
that email/password, and you'll see a simple panel to add or edit news
articles, shows, and the site's text. Every save updates the live site
within about a minute (Netlify rebuilds it automatically).

## Local preview (optional, needs Node.js installed)

```
npm install
npm run start
```

Opens the site at `http://localhost:8080` so you can preview changes before
pushing them.
