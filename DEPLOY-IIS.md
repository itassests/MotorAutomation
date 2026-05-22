# IIS Deployment — points.oneinsure.com

## One-time server setup

1. **Install Node.js LTS** (https://nodejs.org). Verify on the box:
   ```powershell
   node -v
   npm -v
   ```

2. **Install iisnode** (https://github.com/Azure/iisnode/releases). Pick
   the `iisnode-full-v0.2.x-x64.msi` for 64-bit Windows. Install with default
   options. This adds the `iisnode` IIS module and registers the handler.

3. **Install URL Rewrite Module**
   (https://www.iis.net/downloads/microsoft/url-rewrite).

4. **Create the IIS site / application**
   - In IIS Manager → *Sites* → *Add Website* (or add an application under
     an existing site).
   - **Site name**: `points.oneinsure.com`
   - **Physical path**: `D:\inetpub\sites\points.oneinsure.com`
   - **Binding**: `https` on `443`, host header `points.oneinsure.com`
     (use the matching SSL cert).
   - **Application Pool**:
     - .NET CLR Version: **No Managed Code**
     - Identity: a dedicated service account (or `ApplicationPoolIdentity`
       with NTFS R/W permission on the app folder, `uploads`, `exports`,
       and `iisnode` subfolders).
     - Recycle interval: 1080 min (~18h) is fine.

5. **Create folders** (and give the app-pool user R/W on the writable ones):
   ```powershell
   New-Item D:\inetpub\sites\points.oneinsure.com -ItemType Directory -Force
   icacls "D:\inetpub\sites\points.oneinsure.com\uploads"  /grant "IIS AppPool\points.oneinsure.com:(OI)(CI)M" /T
   icacls "D:\inetpub\sites\points.oneinsure.com\exports"  /grant "IIS AppPool\points.oneinsure.com:(OI)(CI)M" /T
   icacls "D:\inetpub\sites\points.oneinsure.com\iisnode"  /grant "IIS AppPool\points.oneinsure.com:(OI)(CI)M" /T
   ```

## Per-release deploy

1. **Copy the app folder** to the server (excluding `node_modules`):
   ```powershell
   # From the dev box, use robocopy (preserves attributes, faster than xcopy):
   robocopy D:\Code\RateExtract \\PROD-SERVER\d$\inetpub\sites\points.oneinsure.com /MIR /XD node_modules .git _tmp tmp uploads exports iisnode
   ```

2. **Install production dependencies on the server**:
   ```powershell
   cd D:\inetpub\sites\points.oneinsure.com
   npm ci --omit=dev
   ```

3. **Set environment variables**. Two options:

   **Option A — machine-level (preferred)**: edit at *This PC → Properties
   → Advanced system settings → Environment Variables → System variables*.
   Set the values from `iisnode.env.example`. Then run:
   ```powershell
   iisreset
   ```

   **Option B — appcmd**: per-application-pool. Run elevated PowerShell:
   ```powershell
   $apppool = "points.oneinsure.com"
   & "$env:windir\system32\inetsrv\appcmd.exe" set config /section:applicationPools `
     "/[name='$apppool'].environmentVariables.[name='DB_HOST',value='10.0.0.10']"
   # …repeat for each var, then:
   iisreset
   ```

4. **Apply schema migration** (creates `state`, `applied_on`, etc.):
   ```powershell
   cd D:\inetpub\sites\points.oneinsure.com
   node db\migrate.js
   ```

5. **Smoke test**:
   ```powershell
   Invoke-WebRequest https://points.oneinsure.com/api/upload/rate-cards | Select StatusCode
   ```
   Expected: `200`.

6. **Trigger an app-pool recycle** to be sure iisnode picks up the new code:
   ```powershell
   Restart-WebAppPool -Name "points.oneinsure.com"
   ```

## Troubleshooting

- **502 / "iisnode encountered an error"** — check `iisnode\*.log` under
  the app folder. Most common: missing env var (DB_PASSWORD, etc.) or a
  permission problem on `uploads/`.
- **Cannot find module 'mssql'** — `npm ci` wasn't run, or it ran in the
  wrong folder. Confirm `node_modules` exists at the app root.
- **Uploads fail with "Maximum request length exceeded"** —
  `requestLimits maxAllowedContentLength` in `web.config` is currently
  50 MB. Bump if you have a workbook bigger than that.
- **`watchedFiles` is restarting too aggressively** — narrow the glob in
  `web.config`'s `<iisnode>` element.
- **PDF parsing failing on server but working locally** — the `pdf-parse`
  package ships compiled pdfjs assets; if `npm ci` was run on the wrong
  node version, re-run `npm rebuild`.

## Update process (subsequent deploys)

Just step 1 + 2 + 6 above (no schema migration unless `db/schema.sql`
changed; no env-var change unless `iisnode.env.example` gained a new key).
