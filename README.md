<!-- README based on jlesage's one for MKVToolNix -->
# Docker container for LosslessCut

[LosslessCut]: https://github.com/mifi/lossless-cut

[![Build and test](https://github.com/jaleung/docker-losslesscut/actions/workflows/ci.yaml/badge.svg)](https://github.com/jaleung/docker-losslesscut/actions/workflows/ci.yaml)
[![Deploy image to registry](https://github.com/jaleung/docker-losslesscut/actions/workflows/build-and-deploy.yaml/badge.svg)](https://github.com/jaleung/docker-losslesscut/actions/workflows/build-and-deploy.yaml)
[![GitHub](https://img.shields.io/github/license/jaleung/docker-losslesscut)](https://github.com/jaleung/docker-losslesscut/blob/master/LICENSE)

This is a Docker container for [LosslessCut].

The GUI of the application is accessed through a modern web browser (no installation or configuration needed on the client side) or via any VNC client.

This is a fork of [outlyer-net/docker-losslesscut](https://github.com/outlyer-net/docker-losslesscut), updated to the current LosslessCut and tuned for small hosts shared with other services, such as a NAS:

* Runs at a lower priority than the host's services and restarts LosslessCut if it crashes.
* Works with Docker's default 64MB `/dev/shm`, no `--shm-size` needed.
* Avoids CPU-heavy GPU emulation when there's no GPU, and uses the GPU (e.g. Intel Quick Sync) for decoding when `/dev/dri` is available.
* A ready-to-use [QNAP Container Station](#qnap-container-station) setup.
* Every change is smoke tested: the image is started with 3 CPUs and 2GB of memory, a video is opened and a cut is exported.

---

[![LosslessCut logo](https://images.weserv.nl/?url=https://github.com/mifi/lossless-cut/raw/master/src/renderer/src/icon.svg&w=160)][LosslessCut]

**LosslessCut**\
The swiss army knife of lossless video/audio editing 

---

## Table of Content

   * [Quick Start](#quick-start)
   * [QNAP Container Station](#qnap-container-station)
   * [Usage](#usage)
      * [Environment Variables](#environment-variables)
      * [Data Volumes](#data-volumes)
      * [Ports](#ports)
      * [Finding Files in Large Folders](#finding-files-in-large-folders)
      * [Segments from File Names](#segments-from-file-names)
      * [Export Defaults](#export-defaults)
      * [Background Trimming (Auto-trim)](#background-trimming-auto-trim)
      * [Hardware Acceleration](#hardware-acceleration)
      * [Audio playback](#audio-playback)
      * [Low Resource Hosts](#low-resource-hosts)
      * [Changing Parameters of a Running Container](#changing-parameters-of-a-running-container)
   * [Docker Compose File](#docker-compose-file)
   * [Docker Image Versioning](#docker-image-versioning)
   * [User/Group IDs](#usergroup-ids)
   * [Accessing the GUI](#accessing-the-gui)
   * [Security](#security)
   * [Shell Access](#shell-access)
   * [Maintenance](#maintenance)
   * [Support or Contact](#support-or-contact)

## Quick Start

Launch the LosslessCut docker container with the following command:
```shell
docker run -d \
    --name=losslesscut \
    -p 5800:5800 \
    -v /path/to/data/losslesscut:/config:rw \
    -v $HOME:/storage:rw \
    ghcr.io/jaleung/docker-losslesscut
```

Where:
  - `/path/to/data/losslesscut`: Where the application stores any persistent data.
  - `$HOME`: This location contains files from your host that need to be accessible to the application.

Browse to `https://your-host-ip:5800` to access the LosslessCut GUI. It uses a self-signed certificate, so the browser shows a warning the first time: choose to continue (in Chrome/Edge: *Advanced → Proceed*). For plain HTTP instead, add `-e SECURE_CONNECTION=0 -e WEB_NOTIFICATION=0`.
Files from the host appear under the `/storage` folder in the container, which is also where the file dialogs open.

**Notes:**
* This Docker command is given as an example and parameters should be adjusted to your needs.
* The image is available in the GitHub Container Registry as `ghcr.io/jaleung/docker-losslesscut`, for `amd64`, `arm64` and `armv7`.
* For additional documentation see the [base image](https://github.com/jlesage/docker-baseimage-gui).

## QNAP Container Station

The file [`docker-compose.qnap.yaml`](docker-compose.qnap.yaml) is ready to be used with Container Station 3 (QTS 5 / QuTS hero).
It's tuned for a small NAS such as the TS-453BT3 (Intel Celeron J3455, 4 cores, up to 8GB of memory): LosslessCut gets up to 3 CPU cores and 2GB of memory, runs with a lower priority than QTS, and uses the Intel GPU for decoding.

1. **Make sure the image can be pulled.** Packages published to GHCR are private at first. Either:
   * make it public, on GitHub: *your profile → Packages → docker-losslesscut → Package settings → Change visibility*, or
   * in Container Station, *Registry → Add*, with `ghcr.io`, your GitHub user name and a [personal access token](https://github.com/settings/tokens) with the `read:packages` scope as the password.
2. **Create a folder for the settings**, e.g. `Container/losslesscut` in File Station (`/share/Container/losslesscut`).
3. **Find the user and group IDs** that should own the files LosslessCut creates. Enable SSH (*Control Panel → Network & File Services → Telnet / SSH*), connect, and run `id <your user name>`:
   ```
   uid=500(john) gid=100(everyone) groups=100(everyone),0(administrators)
   ```
   Use the `uid` as `USER_ID` and the `gid` as `GROUP_ID`. Avoid the `admin` user (uid 0), the application would run as root.
4. **Create the application**: *Container Station → Applications → Create*, name it `losslesscut`, and paste the content of [`docker-compose.qnap.yaml`](docker-compose.qnap.yaml). Adjust the lines marked with `CHANGE ME`:
   * the settings folder from step 2 and the share with your videos (`/share/Multimedia` by default),
   * `USER_ID` and `GROUP_ID` from step 3,
   * `TZ`, your [time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
5. Browse to `https://<NAS IP>:5800`. The image uses HTTPS with a self-signed certificate, so the browser shows a warning the first time: choose to continue (in Chrome/Edge: *Advanced → Proceed*).

If the application fails to start with an error about `/dev/dri`, your NAS has no usable GPU: remove the `devices:` section.

**Finding files**: in the *Open file* dialog, just start typing (or click the magnifier at the top right) to search the current folder, see [Finding Files in Large Folders](#finding-files-in-large-folders).

**Segments from file names**: name a video e.g. `[6604.630613-9797.852513]New Video.mp4` or `New Video[6604.630613-9797.852513].mp4`, and the segment is ready to export when you open it in LosslessCut, see [Segments from File Names](#segments-from-file-names).

**Exporting**: the exported file is named e.g. `NEW VIDEO-trimmed.mp4`, and the original video and its project file are then moved to the trash automatically, see [Export Defaults](#export-defaults). The trash is the hidden `.Trash-<USER_ID>` folder at the top of the share, e.g. `/share/Multimedia/.Trash-500`: enable *Show hidden files* in File Station's settings to see it, and empty it from there.

**Trimming in the background**: switch on *Auto-trim* in the side panel to have videos with segments in their name trimmed automatically, one at a time, without opening them, see [Background Trimming](#background-trimming-auto-trim).

**Notification when an export is done**: like the desktop app, LosslessCut can tell you when an export (or a merge) is finished or has failed, with the usual notification sound of your computer. It's enabled by default (`WEB_NOTIFICATION=1`, which needs `SECURE_CONNECTION=1`, also the default). The browser asks for permission on your first click in the page: choose *Allow*. The page has to stay open, it can be in a background tab. On Windows, the sound follows *Settings → System → Notifications → Google Chrome/Microsoft Edge → Play a sound*. In LosslessCut, *Settings → Prompts and dialogs → Show notifications* must stay enabled (the default).

**Copy and paste**: to copy and paste directly between your computer and LosslessCut (e.g. timecodes), use Chrome or Edge, open the side panel (the tab on the left edge), and enable *Settings → Sync with Host Clipboard*; allow clipboard access when the browser asks. This needs HTTPS (`SECURE_CONNECTION=1`, the default): over plain `http://` the switch isn't shown. Firefox and Safari don't support it, use the *Clipboard* box of the side panel instead. To get rid of the certificate warning, copy a certificate for the NAS (e.g. from myQNAPcloud) to `certs/web-privkey.pem` and `certs/web-fullchain.pem` in the settings folder, see [Certificates](#certificates).

**Checking hardware acceleration**: the container's log in Container Station shows `[startapp] GPU enabled (render node: /dev/dri/renderD128)` when the GPU is used. Over SSH, `docker exec losslesscut vainfo` should list the supported codecs (`VAProfileH264...`, `VAProfileHEVC...`). To also let LosslessCut's FFmpeg use it, set *Settings → FFmpeg hardware acceleration* to `vaapi` in LosslessCut. See [Hardware Acceleration](#hardware-acceleration) if something doesn't work.

**Updating**: once a new image is published, pull it and recreate the container, e.g. over SSH:
```shell
docker pull ghcr.io/jaleung/docker-losslesscut:latest
```
then recreate the application in Container Station (or delete it and create it again with the same YAML). Settings are kept in the settings folder.

See also [Low Resource Hosts](#low-resource-hosts).

## Usage

```shell
docker run [-d] \
    [--name=losslesscut] \
    [-e <VARIABLE_NAME>=<VALUE>]... \
    [-v <HOST_DIR>:<CONTAINER_DIR>[:PERMISSIONS]]... \
    [-p <HOST_PORT>:<CONTAINER_PORT>]... \
    ghcr.io/jaleung/docker-losslesscut
```
| Parameter | Description |
|-----------|-------------|
| `--rm`    | Destroy the container once it stops. |
| `-d`      | Run the container in the background.  If not set, the container runs in the foreground. |
| `-e`      | Pass an environment variable to the container.  See the [Environment Variables](#environment-variables) section for more details. |
| `-v`      | Set a volume mapping (allows to share a folder/file between the host and the container).  See the [Data Volumes](#data-volumes) section for more details. |
| `-p`      | Set a network port mapping (exposes an internal container port to the host).  See the [Ports](#ports) section for more details. |
| `--name`  | Assign a name to the container |

### Environment Variables

To customize some properties of the container, the following environment variables can be passed via the `-e` parameter (one for each variable).\
Values of this parameter has the format `<VARIABLE_NAME>=<VALUE>`.

Variables specific to this image:

| Variable       | Description                                  | Default |
|----------------|----------------------------------------------|---------|
|`LOSSLESSCUT_GPU`| `auto`: use the GPU when `/dev/dri` is passed to the container and usable, `1`: always try to use the GPU, `0`: never use the GPU.  See [Hardware Acceleration](#hardware-acceleration). | `auto` |
|`LOSSLESSCUT_DISABLE_NETWORKING`| When set to `1`, LosslessCut works offline: no update checks (updates come with new images). Set to `0` to download media from URLs. | `1` |
|`LOSSLESSCUT_DEFAULT_SETTINGS`| When set to `1`, the [export defaults](#export-defaults) of this image (output file name, cleanup after export) are applied to the LosslessCut settings you haven't changed yourself. Set to `0` to keep LosslessCut's own defaults. | `1` |
|`LOSSLESSCUT_FILENAME_SEGMENTS`| When set to `1`, videos with segments in their name get a project file, see [Segments from File Names](#segments-from-file-names). Set to `0` to disable. | `1` |
|`LOSSLESSCUT_FILENAME_SEGMENTS_PATHS`| Folders where videos with segments in their name are looked for (with their subfolders): `auto` for every folder mapped into the container except `/config`, or a comma-separated list, e.g. `/storage/To cut`. | `auto` |
|`LOSSLESSCUT_AUTOTRIM`| When set to `1`, videos with segments in their name can be trimmed in the background: switched on and off in the side panel of the web page, off until switched on. Set to `0` to remove the feature. See [Background Trimming](#background-trimming-auto-trim). | `1` |
|`LOSSLESSCUT_AUTOTRIM_INTERVAL`| Seconds between two checks of the folders for videos to trim, while background trimming is switched on. | `60` |
|`LOSSLESSCUT_ARGS`| Additional [command line arguments](https://github.com/mifi/lossless-cut/blob/master/docs/cli.md) for LosslessCut, e.g. `--http-api` or files to open. | `""` |

Common variables, provided by the [base image](https://github.com/jlesage/docker-baseimage-gui#environment-variables) (which has more):

| Variable       | Description                                  | Default |
|----------------|----------------------------------------------|---------|
|`USER_ID`| ID of the user the application runs as.  See [User/Group IDs](#usergroup-ids) to better understand when this should be set. | `1000` |
|`GROUP_ID`| ID of the group the application runs as.  See [User/Group IDs](#usergroup-ids) to better understand when this should be set. | `1000` |
|`SUP_GROUP_IDS`| Comma-separated list of supplementary group IDs of the application. | `""` |
|`UMASK`| Mask that controls how file permissions are set for newly created files. The value of the mask is in octal notation.  By default, the default umask value is `0022`, meaning that newly created files are readable by everyone, but only writable by the owner.  See the online umask calculator at http://wintelguy.com/umask-calc.pl. | `0022` |
|`LANG`| Set the [locale](https://en.wikipedia.org/wiki/Locale_(computer_software)), which defines the application's language, **if supported**.  Format of the locale is `language[_territory][.codeset]`, where language is an [ISO 639 language code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes), territory is an [ISO 3166 country code](https://en.wikipedia.org/wiki/ISO_3166-1#Current_codes) and codeset is a character set, like `UTF-8`.  For example, Australian English using the UTF-8 encoding is `en_AU.UTF-8`. | `en_US.UTF-8` |
|`TZ`| [TimeZone](http://en.wikipedia.org/wiki/List_of_tz_database_time_zones) used by the container.  Timezone can also be set by mapping `/etc/localtime` between the host and the container. | `Etc/UTC` |
|`KEEP_APP_RUNNING`| When set to `1`, the application will be automatically restarted when it crashes or terminates. | `1` (base image: `0`) |
|`APP_NICENESS`| Priority at which the application (and the FFmpeg processes it starts) should run.  A niceness value of -20 is the highest priority and 19 is the lowest priority.  **NOTE**: A negative niceness (priority increase) requires additional permissions.  In this case, the container should be run with the docker option `--cap-add=SYS_NICE`. | `10` (base image: `0`) |
|`INSTALL_PACKAGES`| Space-separated list of packages to install during the startup of the container.  Packages are installed from the repository of the Linux distribution this container is based on.  **ATTENTION**: Container functionality can be affected when installing a package that overrides existing container files (e.g. binaries). | `""` |
|`CONTAINER_DEBUG`| Set to `1` to enable debug logging. | `0` |
|`DISPLAY_WIDTH`| Width (in pixels) of the application's window. | `1920` |
|`DISPLAY_HEIGHT`| Height (in pixels) of the application's window. | `1080` |
|`DARK_MODE`| When set to `1`, dark mode is enabled for the application. | `0` |
|`WEB_AUDIO`| When set to `1`, audio support is enabled, meaning that any audio produced by the application is played through the browser. Note that audio is not supported for VNC clients. | `0` |
|`WEB_NOTIFICATION`| When set to `1`, desktop notifications of the application (e.g. "Export finished") are shown by the browser, with the system's notification sound. Requires `SECURE_CONNECTION`, the container doesn't start otherwise: set both to `0` for plain HTTP. | `1` (base image: `0`) |
|`WEB_AUTHENTICATION`| When set to `1`, the GUI is protected by a login page when accessed with a browser. Requires `SECURE_CONNECTION`, see the [base image documentation](https://github.com/jlesage/docker-baseimage-gui#web-authentication). | `0` |
|`WEB_FILE_MANAGER`| When set to `1`, a simple file manager (upload, download, rename, delete) is available in the web interface. | `0` |
|`SECURE_CONNECTION`| When set to `1`, an encrypted connection is used to access the application's GUI (either via a web browser or VNC client).  See the [Security](#security) section for more details. | `1` (base image: `0`) |
|`WEB_LISTENING_PORT`| Port used by the web server to serve the UI of the application.  This port is used internally by the container and it is usually not required to be changed.  **NOTE**: a value of `-1` disables listening, meaning that the application's UI won't be accessible over HTTP/HTTPs. | `5800` |
|`VNC_LISTENING_PORT`| Port used by the VNC server to serve the UI of the application.  This port is used internally by the container and it is usually not required to be changed.  **NOTE**: a value of `-1` disables listening, meaning that the application's UI won't be accessible over VNC. | `5900` |
|`VNC_PASSWORD`| Password needed to connect to the application's GUI.  See the [VNC Password](#vnc-password) section for more details. | `""` |
|`ENABLE_CJK_FONT`| When set to `1`, open-source computer font `WenQuanYi Zen Hei` is installed.  This font contains a large range of Chinese/Japanese/Korean characters. | `0` |

### Data Volumes

The following table describes data volumes used by the container. \
The mappings are set via the `-v` parameter.\
Each mapping is specified with the following format:\
`<HOST_DIR>:<CONTAINER_DIR>[:PERMISSIONS]`.

| Container path  | Permissions | Description |
|-----------------|-------------|-------------|
|`/config`| rw | This is where the application stores its configuration, states, log and any files needing persistency. LosslessCut's own settings and log are in `/config/xdg/config/LosslessCut`, the file dialog's settings (sort order, size) in `/config/xdg/config/glib-2.0/settings/keyfile`. |
|`/storage`| rw | This location contains files from your host that need to be accessible to the application. The file dialogs open here and it's bookmarked in their sidebar. |

### Ports

Here is the list of ports used by the container.  They can be mapped to the host
via the `-p` parameter (one per port mapping).  Each mapping is defined in the
following format: `<HOST_PORT>:<CONTAINER_PORT>`.  The port number inside the
container cannot be changed, but you are free to use any port on the host side.

| Port | Mapping to host | Description |
|------|-----------------|-------------|
| 5800 | Optional | Port to access the application's GUI via the web interface.  Mapping to the host is optional if access through the web interface is not wanted.  For a container not using the default bridge network, the port can be changed with the `WEB_LISTENING_PORT` environment variable. |
| 5900 | Optional | Port to access the application's GUI via the VNC protocol.  Mapping to the host is optional if access through the VNC protocol is not wanted.  For a container not using the default bridge network, the port can be changed with the `VNC_LISTENING_PORT` environment variable. |

### Finding Files in Large Folders

The *Open file* dialog can search the folder it shows, which helps with folders holding hundreds of videos:

* **Start typing**, or click the **magnifier** at the top right: the list only shows the files whose name contains what you typed. Case doesn't matter, and several words narrow it down, e.g. `paris 2024` finds `Holiday_Paris_2024-07.mp4`. Only the current folder is searched, not its subfolders.
* Click the **magnifier** again to go back to the whole folder. Several files can be selected with **Ctrl**/**Shift**+click, they're opened as a batch.
* **Click a column header** to sort, e.g. *Modified* twice for the newest files first. The sort order and the size of the dialog are remembered.

*Open folder* (in the *File* menu) loads all the files of a folder in LosslessCut's batch list instead, which can be sorted but not searched.

### Segments from File Names

When the name of a video starts with time ranges in square brackets, or has them right before the extension, these ranges are ready as segments when the video is opened in LosslessCut:

```
[6604.630613-9797.852513]New Video.mp4      one segment, from 6604.630613s to 9797.852513s
New Video[6604.630613-9797.852513].mp4      the same
[0-95.5, 120-300, 2710-end]Interview.mkv    three segments
```

* Each `start-end` range is a part to **keep**, in seconds (with decimals or not). Several ranges are separated by commas, spaces are allowed.
* `0` is the beginning of the video, and `end` (or `END`) its end.
* Only the brackets at the start of the name or right before the extension count: `[5-60]My [draft] clip.mp4` and `My [draft] clip[5-60].mp4` both have one segment, from 5 to 60s. If both have valid ranges, the ones at the start are used.
* Names that don't follow this are left alone, the video opens as usual, e.g. `Holiday[draft].mp4`, `Clip [10-20] copy.mp4`, `clip[1:00-2:00].mp4`, or a range ending before it starts like `clip[20-10].mp4`.

How it works: the container watches every folder mapped into it, e.g. `/storage` or `/medias`, except `/config` (see `LOSSLESSCUT_FILENAME_SEGMENTS_PATHS` in [Environment Variables](#environment-variables)). It writes a LosslessCut project file next to each such video, e.g. `[6604.630613-9797.852513]New Video-proj.llc`, which LosslessCut loads when it opens the video. The container log lists the watched folders (`scanning ...`).

* Videos copied, moved or renamed into the folder get their project file a moment after the copy is complete. Videos already there are handled when the container starts.
* An existing project file is never replaced. Once you've changed the segments in LosslessCut (which saves the project), your changes are kept. To go back to the segments of the file name, delete the `-proj.llc` file before opening the video again.
* Project files created this way are removed when their video is deleted, moved away or renamed (a renamed video gets a new one), unless LosslessCut has saved changes to them.
* Hidden folders and QNAP's system folders (`@Recycle`, `.@__thumb`, `.Trash-*`, ...) are skipped.
* Lossless cuts start on a keyframe: an exported part can start a little before the time in the name (LosslessCut's usual *keyframe cut* behavior).
* With a huge number of subfolders, the container may not be allowed to watch all of them: it then looks for new videos every minute instead, and says so in its log.

### Export Defaults

The image changes some of LosslessCut's default settings:

| Setting (in LosslessCut) | Default of this image |
|--------------------------|-----------------------|
| Output file name template, for *Export* and for *Export + merge* | `${FILENAME.replace(/\[[^\]]*\]\s*/g, '').toUpperCase()}-trimmed${EXT}`: the name without its `[...]` parts, in capitals, followed by `-trimmed`, e.g. `New Video[6604.630613-9797.852513].mp4` or `[6604.630613-9797.852513] New Video.mp4` → `NEW VIDEO-trimmed.mp4` |
| Cleanup after export | Done automatically, without asking: move the source video, its project file and LosslessCut's temporary files to the trash, delete them permanently if they can't be moved to the trash, and close the file |

* These are applied when LosslessCut starts, only to the settings you haven't changed: a template or cleanup choice you set yourself in LosslessCut is kept, also when updating the image. Set `LOSSLESSCUT_DEFAULT_SETTINGS=0` to keep LosslessCut's own defaults instead, or pass your own settings with `--settings-json` in `LOSSLESSCUT_ARGS` (the defaults are then skipped).
* When several segments are exported as separate files (without merging), the template gives them all the same name, so LosslessCut uses its own template for them, which adds the segment number.
* The trash: files are moved to the hidden `.Trash-<USER_ID>` folder at the top of the mapped folder they're in, e.g. `/share/Multimedia/.Trash-500` on a QNAP NAS for a share mapped to `/storage` or `/medias`. It isn't emptied automatically. To restore a file, move it back from the `files` folder in there.
* If the output file already exists, LosslessCut overwrites it without asking (its *Overwrite existing files* setting, on by default). Videos whose names only differ in their `[...]` part, e.g. `Clip[1-2].mp4` and `Clip[5-9].mp4`, both export to `CLIP-trimmed.mp4`: move or rename the first export before exporting the second one. Turning that setting off doesn't help here: LosslessCut then skips the existing file, still treats the export as done, and the cleanup runs.

### Background Trimming (Auto-trim)

Videos with segments in their name can also be trimmed without opening them in LosslessCut: switch on **Auto-trim** in the side panel of the web page (the tab on the left edge).

* While it's on, the folders mapped into the container are checked every minute for videos named like in [Segments from File Names](#segments-from-file-names). A video is picked up once it hasn't changed for 30 seconds, so files still being copied are left alone.
* Videos are trimmed **one at a time**, oldest first, the others wait in a queue. Trimming only copies data (no re-encoding), with the lowest CPU and disk priority, so other services of the NAS come first.
* The result is the same as *Export + merge* in LosslessCut (keyframe cut): the output is named after LosslessCut's file name template, e.g. `NEW VIDEO-trimmed.mp4` with the [export defaults](#export-defaults), and the source and its project file are cleaned up as LosslessCut's *Cleanup after export* setting says (moved to the trash with the defaults). An existing file is never overwritten: ` (2)` is added to the name instead.
* The trimmed video keeps the original's metadata: the same modified (and accessed) date and permissions as the original, and its tags (title, creation time, comment, ...), also when several segments are merged. LosslessCut's *Preserve metadata* setting applies (e.g. *None* keeps no tags). Two things can't be kept: the *date created* (Linux can't set it, so it's the time of the trim), and the owner (the container's user, `USER_ID`).
* If you changed a video's segments in LosslessCut, your segments are used rather than the ones in the name. A video you open or edit in LosslessCut waits: it's trimmed in the background only once LosslessCut hasn't saved its project for 10 minutes (LosslessCut saves it when opening the video and after each change). Meanwhile it's listed as waiting, *edited in LosslessCut*.
* A video that fails (e.g. a damaged file) isn't tried again until it changes or you click *Retry failed*. With `WEB_NOTIFICATION`, the browser also shows a notification for each video.
* Switching it off stops the current trim (its source is kept, and trimmed when switched on again) and the checks: nothing runs in the background while it's off. The switch is remembered across restarts and image updates.

To follow it, while LosslessCut is in use:

* **Status box**, at the top right over LosslessCut, while a video is being trimmed or waits: the video being trimmed with its progress and the time left, then the waiting ones with why they wait (*next*, *copying* while the file is still changing, *checking*, *edited in LosslessCut*). Drag it by its title bar to move it, click ▾ to fold it into one line (e.g. "64% · 3 waiting"), double-click its title bar to put it back in the corner. It goes away 15 seconds after the last trim. To hide it, switch off *Status box over LosslessCut* in the side panel (remembered by the browser).
* **Badge** on the side panel tab (left edge): the progress and the number of waiting videos. Click it to open the side panel at its *Auto-trim* section.
* **Side panel**: the switch, the video being trimmed, the waiting ones and the last results. It refreshes as soon as it opens.
* **Status page**: `https://<NAS IP>:5800/autotrim/` shows everything on one page: the switch, the progress, the whole queue with full paths (and, for a video edited in LosslessCut, the earliest time it can be trimmed), and the last 20 results. Handy in another tab or on a phone. *Open full list* in the status box and in the side panel leads there.

`LOSSLESSCUT_AUTOTRIM=0` removes the feature and its section of the side panel, `LOSSLESSCUT_AUTOTRIM_INTERVAL` changes how often the folders are checked, and `LOSSLESSCUT_FILENAME_SEGMENTS_PATHS` which folders (see [Environment Variables](#environment-variables)). The container log shows what's done (`[autotrim]` lines).

### Hardware Acceleration

Decoding video on the CPU is the most expensive part of previewing videos, especially HEVC (H.265) and 4K on a small CPU. With an Intel (Quick Sync) or AMD GPU, it can be done by the GPU instead:

1. Pass the GPU to the container: `--device /dev/dri:/dev/dri` (or the `devices:` section of the compose files).
2. With the default `LOSSLESSCUT_GPU=auto`, the GPU is used if it's accessible. The container log shows either `GPU enabled` or `GPU disabled`. Permissions of `/dev/dri` are handled by the base image, its checks are also in the log.
3. `docker exec losslesscut vainfo` shows what the GPU can decode.
4. Optionally, in LosslessCut, set *Settings → FFmpeg hardware acceleration* to `vaapi`, so that FFmpeg-assisted playback (for formats the player doesn't support) uses the GPU too.

If videos show up black or glitched, set `LOSSLESSCUT_GPU=0`.

Without a GPU, LosslessCut is started with `--disable-gpu`, which is cheaper than Chromium's default of emulating a GPU on the CPU.

The VAAPI drivers (Intel and AMD) are only included in the `amd64` image.

### Audio playback

Audio can be played when accessed via web browser.

To enable it set the environment variable `WEB_AUDIO` to `1`.

You'll also need to enable audio from within the browser via the three-dots menu overlaid on the left hand of the window.

See the [Environment Variables section](#environment-variables)

### Low Resource Hosts

The defaults of this image already suit hosts shared with other services (lower priority, automatic restarts, no dependency on `/dev/shm` size). Some more things that help:

* **Limit CPU and memory** so LosslessCut can't starve other services: `--cpus 3 --memory 2g` (`cpus:` and `mem_limit:` in compose). 2GB is enough for HD videos, give it 3GB for 4K. If LosslessCut runs out of memory it's restarted automatically, and `docker inspect -f '{{.State.OOMKilled}}' losslesscut` tells if the whole container was killed.
* **Use a smaller screen**: every pixel of `DISPLAY_WIDTH` × `DISPLAY_HEIGHT` has to be encoded and sent to the browser. `1600x900` or `1280x720` are noticeably lighter than `1920x1080`.
* **Use the GPU** if there's one, see [Hardware Acceleration](#hardware-acceleration).
* **In LosslessCut**, keep thumbnails and the waveform disabled for large files, and pause playback when not needed: most of the work of a lossless cut is copying data, which is cheap.
* **Limit log sizes**, the compose files keep at most 30MB of container logs.

### Changing Parameters of a Running Container

As can be seen, environment variables, volume and port mappings are all specified while creating the container.

The following steps describe the method used to add, remove or update parameter(s) of an existing container.  The general idea is to destroy and
re-create the container:

  1. Stop the container (if it is running):
```
docker stop losslesscut
```
  2. Remove the container:
```
docker rm losslesscut
```
  3. Create/start the container using the `docker run` command, by adjusting
     parameters as needed.

**NOTE**: Since all application's data is saved under the `/config` container folder, destroying and re-creating a container is not a problem: nothing is lost and the application comes back with the same state (as long as the mapping of the `/config` folder remains the same).

## Docker Compose File

An example [`docker-compose.yaml`](docker-compose.yaml) file is provided for use with [Docker Compose](https://docs.docker.com/compose/), and [`docker-compose.qnap.yaml`](docker-compose.qnap.yaml) for a NAS with limited resources (see [QNAP Container Station](#qnap-container-station)).

Make sure to adjust according to your needs.  Note that only mandatory network ports are part of the examples.

## Docker Image Versioning

Each release of a Docker image is versioned using [semantic versioning](https://semver.org) matching the version of the bundled LosslessCut.\
Additional tags for *major* and *major.minor* versions are also provided.
\
In case the image is updated it will have an additional `-v<NUMBER>` indicating the new version.

Example tags:
| Tag | Interpret as 
|-----|-----------------------------------------------
| `:latest` | Always points to the most up to date image
| `:3.69.0` | LosslessCut v3.69.0
| `:3.69`   | Latest image built with LosslessCut v3.69.x
| `:3`      | Latest image built with LosslessCut v3.x.y
| `:3.69-v1`| First image built with LosslessCut v3.69.x

## User/Group IDs

When using data volumes (`-v` flags), permissions issues can occur between the host and the container.\
For example, the user within the container may not
exist on the host.\
This could prevent the host from properly accessing files and folders on the shared volume.

To avoid any problem, you can specify the user the application should run as.

This is done by passing the user ID and group ID to the container via the `USER_ID` and `GROUP_ID` environment variables.

To find the right IDs to use, issue the following command on the host, with the
user owning the data volume on the host:
```shell
$ id <username>
```

Which gives an output like this one:
```
uid=1000(myuser) gid=1000(myuser) groups=1000(myuser),4(adm),24(cdrom),27(sudo),46(plugdev),113(lpadmin)
```

The value of `uid` (user ID) and `gid` (group ID) are the ones that you should be given the container.

## Accessing the GUI

Assuming that container's ports are mapped to the same host's ports, the
graphical interface of the application can be accessed via:

  * A web browser:
```
https://<HOST IP ADDR>:5800
```
(`http://` with `SECURE_CONNECTION=0`)

  * Any VNC client:
```
<HOST IP ADDR>:5900
```

## Security

By default, this image uses an encrypted connection (`SECURE_CONNECTION=1`), with a self-signed certificate (see [Certificates](#certificates)).
To use an unencrypted connection (HTTP and VNC) instead, set `SECURE_CONNECTION=0` and `WEB_NOTIFICATION=0` (notifications need HTTPS).\
See the [Environment Variables](#environment-variables) section for more details on how to set an environment variable.

When enabled, application's GUI is performed over an HTTPs connection when accessed with a browser.\
All HTTP accesses are automatically redirected to HTTPs.

When using a VNC client, the VNC connection is performed over SSL.\
Note that few VNC clients support this method.  [SSVNC] is one of them.

To require a user name and password in the browser, enable `WEB_AUTHENTICATION` too (see the [base image documentation](https://github.com/jlesage/docker-baseimage-gui#web-authentication)). This is recommended if the port is reachable from outside your local network.

[SSVNC]: http://www.karlrunge.com/x11vnc/ssvnc.html

### Certificates

Here are the encryption certificate files needed by the container.\
By default, when they are missing, self-signed certificates are generated and used.\
All files have PEM encoded, x509 certificates.

| Container Path                  | Purpose                    | Content |
|---------------------------------|----------------------------|---------|
|`/config/certs/vnc-server.pem`   |VNC connection encryption.  |VNC server's private key and certificate, bundled with any root and intermediate certificates.|
|`/config/certs/web-privkey.pem`  |HTTPs connection encryption.|Web server's private key.|
|`/config/certs/web-fullchain.pem`|HTTPs connection encryption.|Web server's certificate, bundled with any root and intermediate certificates.|

**NOTE**: To prevent any certificate validity warnings/errors from the browser or VNC client, make sure to supply your own valid certificates.

**NOTE**: Certificate files are monitored and relevant daemons are automatically restarted when changes are detected.

### VNC Password

To restrict access to your application, a password can be specified.  This can
be done via two methods:
  * By using the `VNC_PASSWORD` environment variable.
  * By creating a `.vncpass_clear` file at the root of the `/config` volume.
    This file should contain the password in clear-text.  During the container
    startup, content of the file is obfuscated and moved to `.vncpass`.

The level of security provided by the VNC password depends on two things:
  * The type of communication channel (encrypted/unencrypted).
  * How secure the access to the host is.

When using a VNC password, it is highly desirable to enable the secure
connection to prevent sending the password in clear over an unencrypted channel.

**ATTENTION**: Password is limited to 8 characters.  This limitation comes from
the Remote Framebuffer Protocol [RFC](https://tools.ietf.org/html/rfc6143) (see
section [7.2.2](https://tools.ietf.org/html/rfc6143#section-7.2.2)).  Any
characters beyond the limit are ignored.

## Shell Access

To get shell access to the running container, execute the following command:

```shell
docker exec -ti CONTAINER sh
```

Where `CONTAINER` is the ID or the name of the container used during its
creation (e.g. `losslesscut`).

## Maintenance

### Building and testing

```shell
make          # build for the current architecture
make unit-test  # test the scripts of the image (segments from file names, default settings, trash, background trimming), no Docker needed
make test     # the script tests, then smoke test the image built by "make" (needs Docker, and vncdotool for screenshots)
make buildx   # build for amd64, arm64 and armv7
```

The smoke test ([`helper-scripts/smoke-test.sh`](helper-scripts/smoke-test.sh)) starts the image with 3 CPUs and 2GB of memory, waits for it to be healthy, checks libraries, flags, user and priority of LosslessCut, then opens generated videos and exports them through LosslessCut's HTTP API: project files from file names, export defaults (output names, cleanup to the trash), file dialog search, background trimming (queue, name clashes, metadata kept, trash, one at a time, waiting while edited in LosslessCut), and notifications with the image's defaults (HTTPS). With `node` and `playwright-core` (`NODE_PATH`, and Chrome in `CHROME_PATH`), it also checks the auto-trim status box, side panel tab badge, side panel and status page in a browser ([`helper-scripts/ui-check.cjs`](helper-scripts/ui-check.cjs)). Logs and screenshots are written to `smoke-test-output/`.

The build itself fails if a library needed by LosslessCut or FFmpeg is missing, on every architecture.

### GitHub Actions

| Workflow | When | What |
|----------|------|------|
| [Build and test](.github/workflows/ci.yaml) | Every push and pull request | Runs the script tests, builds for amd64 and runs the smoke test, and builds for arm64 and armv7. Screenshots and logs are available as an artifact of the run. |
| [Deploy image to registry](.github/workflows/build-and-deploy.yaml) | Pushes to `master`, tags, manually | Builds for amd64, arm64 and armv7, and publishes the image to `ghcr.io/<owner>/docker-losslesscut` (and Docker Hub when the `DOCKERHUB_USERNAME` and `DOCKERHUB_IMAGE` variables and the `DOCKERHUB_TOKEN` secret are set). Manual runs on other branches only build. |
| [Check for LosslessCut updates](.github/workflows/update-losslesscut.yaml) | Mondays, manually | Opens a pull request when a new LosslessCut version is released, and starts "Build and test" on it. Merging it publishes the new image. |

For all of this to work on a fork:
* Enable Actions in the *Actions* tab of the fork.
* Allow the update check to open pull requests: *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests*.
* GitHub disables scheduled workflows after 60 days without activity in the repository, re-enable it in the *Actions* tab if that happens.

### Updating LosslessCut manually

1. Change `app_version` in the [`Dockerfile`](Dockerfile) and reset `image_revision` to `1` (bump `image_revision` instead when changing the image without changing LosslessCut).
2. Run `make && make test`, or push and let the workflows do it.
3. If the build fails because of a missing library, add the package providing it to the Dockerfile ([`helper-scripts/generate_dependencies_list.bash`](helper-scripts/generate_dependencies_list.bash) can help find it).

## Support or Contact

Having troubles with the container or have questions?  Please
[create a new issue].

For other great Dockerized applications by *[jlesage][jlesage]*, see https://jlesage.github.io/docker-apps.

[jlesage]: https://github.com/jlesage
[create a new issue]: https://github.com/jaleung/docker-losslesscut/issues
