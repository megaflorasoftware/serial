
export default [
  {
    "title": "Categories, Cookies, and Creativity",
    "description": "After a long time away, Serial gets its first substantial contributions of the new year!",
    "publish_date": "2025-03-10",
    "public": true,
    "_meta": {
      "filePath": "2025-03-10.md",
      "fileName": "2025-03-10.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-03-10"
    },
    "slug": "2025-03-10",
    "excerpt": "",
    "content": "#### Features\n\n- Add release notes (these very ones!)\n  - Set up release note pages\n  - Add notifier to let users know when new releases go out\n- Categories are here, for real!\n  - Add and delete categories in the Feeds page\n  - Filter videos with the category bar at the bottom of the page\n    - _Tip: The bottom categories will be grayed out if no videos match the selected filters. This should make it easy to stay on top of lots of categories!_\n\n#### Improvements\n\n- Moved to a popover for theme editing and color mode selection as opposed to needing a fully separate page\n- Change embed URL from **`www.youtube.com`** to **`www.youtube-nocookie.com`** for better user privacy\n- Added refresh button to allow for fetching new videos without reloading the window\n- Clearer spacing and UI in feeds page\n- Data infrastructure simplification\n- General project maintenance\n\n#### Bugfixes\n\n- Fixed an issue where adding a feed by channel username would be flaky, resulting in one of the following:\n  - An error adding feeds\n  - Adding more than one feed"
  },
  {
    "title": "Imports & Shorts",
    "description": "Serial now supports imports from users' two most popular feed formats: OPML and YouTube's subscriptions.csv.",
    "publish_date": "2025-03-16",
    "public": true,
    "_meta": {
      "filePath": "2025-03-16.md",
      "fileName": "2025-03-16.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-03-16"
    },
    "slug": "2025-03-16",
    "excerpt": "",
    "content": "#### Notes\n\nThis release brings the first support for bulk importing feeds into Serial! There is still more progress to be made (namely, in bringing in categories when importing) but this should be a great first step for many users.\n\n#### Features\n\n- Add support for importing **`subscriptions.csv`** files\n  - This is the format provided by Google when exporting your subscriptions via [Google Takeout](https://takeout.google.com).\n- Add support for importing **`OPML`** files\n  - This is the most popular format used by RSS readers. If you follow YouTube channels in an RSS reader currently, this is likely the export format it provides.\n- Add experimental shorts filtering"
  },
  {
    "title": "Super Speed",
    "description": "Serial now has lightning-fast bootup times thanks to local caching of feeds and videos.",
    "publish_date": "2025-04-10",
    "public": true,
    "_meta": {
      "filePath": "2025-04-10.md",
      "fileName": "2025-04-10.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-04-10"
    },
    "slug": "2025-04-10",
    "excerpt": "",
    "content": "#### Features\n\n- Adds local caching for much quicker startup times\n- Re-introduces the ability to toggle forward and backward through the current selection of videos with the \"`[`\" and \"`]`\" keys\n- Added new experimental video player UI, accessible through the \"Appearance\" menu\n\n#### Bugfixes\n\n- Fixes an issue where feed items would dissapear (temporarily) after watching a video\n\n#### Improvements\n\n- Lots of behind-the-scenes data organization and cleanup"
  },
  {
    "title": "Hello, Open Source",
    "description": "Serial no longer relies on an external auth provider, and is now open source!",
    "publish_date": "2025-04-12",
    "public": true,
    "_meta": {
      "filePath": "2025-04-12.md",
      "fileName": "2025-04-12.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-04-12"
    },
    "slug": "2025-04-12",
    "excerpt": "",
    "content": "#### Features\n\n- Serial is now open source! You can [check out the repository](https://github.com/hfellerhoff/serial) for more information.\n- Removes previous auth provider [Clerk](https://clerk.com/) in exchange for auth solution [Better Auth](https://www.better-auth.com/)\n  - If you run into issues with the migration, don't hesitate to reach out to the email at the bottom of the page!\n- Changed default video player to the serial player and added a number of nice-to-have shortcuts from YouTube, namely:\n  - Seeking through the video with number keys\n  - Play/pause with `space`\n  - Slowing down the video with `Shift` + `<`\n  - Speeding up the video with `Shift` + `>`\n\n\n#### Improvements\n- Now opens videos in fullscreen on mobile (as opposed to inline)\n- Added the ability to show and hide shortcuts on actions, such as on the \"Watch Later\" and \"Unwatched\" controls when viewing a video.\n- Many other small improvements and cleanups to get ready for open source."
  },
  {
    "title": "Sidebar Sunday",
    "description": "Serial's categories and feeds have moved to a brand new sidebar, making it easier than ever to filter your content",
    "publish_date": "2025-04-14",
    "public": true,
    "_meta": {
      "filePath": "2025-04-14.md",
      "fileName": "2025-04-14.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-04-14"
    },
    "slug": "2025-04-14",
    "excerpt": "",
    "content": "#### Features\n\n- Adds the ability to filter by feed\n- Reworks the UI to move category and feed filters to a brand new sidebar, making it much easier to filter through videos and stay on top of many categories and feeds."
  },
  {
    "title": "Livelier Livestreams",
    "description": "Serial now differentiates between standard videos and livestreams, offering better UI/UX for watching content live.",
    "publish_date": "2025-04-16",
    "public": true,
    "_meta": {
      "filePath": "2025-04-16.md",
      "fileName": "2025-04-16.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-04-16"
    },
    "slug": "2025-04-16",
    "excerpt": "",
    "content": "#### Features\n\n- Adds better livestream support\n  - Adds \"Go Live\" button that will bring you to the most recent part of a livestream\n  - Adds \"Live\" indicator for when you are caught up to a livestream\n\n#### Improvements\n\n- Adds a button to toggle windowed fullscreen\n  - Alternatively, toggle fullscreen with <kbd>`</kbd> or <kbd>f</kbd>\n- Adds buttons to zoom in and out the active video\n  - Alternatively, zoom in with <kbd>+</kbd> and out with <kbd>-</kbd>\n  - Minor adjustments to zoom, adding one more zoom in step\n- Cleaner logic for custom video player\n- Better shortcut logic when on video page"
  },
  {
    "title": "Quality of Life",
    "description": "Serial gets a variety of UI/UX improvements and a way to send feedback both good and bad",
    "publish_date": "2025-04-18",
    "public": true,
    "_meta": {
      "filePath": "2025-04-18.md",
      "fileName": "2025-04-18.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-04-18"
    },
    "slug": "2025-04-18",
    "excerpt": "",
    "content": "#### Improvements\n\n- UI items in left sidebar are now always visible, even when the list of categories is long\n- Adds \"Report Issue\" and \"Share Idea\" buttons to sidebar\n- More intelligently sets date filter when selecting sidebar items:\n  - When selecting \"All\", sets the date to \"Today\"\n  - When selecting a feed, sets the date to \"This Month\"\n- Adds nicer bottom sheet mobile UI for sidebar items with popup menus"
  },
  {
    "title": "Views, Views, Views",
    "description": "Serial gets the largest update in its recorded history, most notably adding views – a new way to customize your feed.",
    "publish_date": "2025-05-17",
    "public": true,
    "_meta": {
      "filePath": "2025-05-17.md",
      "fileName": "2025-05-17.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-05-17"
    },
    "slug": "2025-05-17",
    "excerpt": "",
    "content": "Hey all! This is by far the biggest update for Serial since they've been tracked.\n\nThis update introduces views, a new way to customize your feed. Views allow you to combine a selection of filters (currently, time and categories) to create custom feeds for your Serial home page. This is the first step is finding ways to combat \"content whiplash\", or that feeling you get when you try to parse through the videos you watch to relax mixed into videos about current news or politics.\n\n#### Features\n\n- Adds views, a new way to organize your feeds\n  - You can now add views in the sidebar\n  - You can now edit views in the sidebar\n  - You can now delete views in the sidebar\n  - You can now reorganize views – by dragging – in the sidebar\n- Improves the experience of working with categories\n  - You can now add categories in the sidebar\n    - Assigning categories to feeds with recent activity can happen here\n  - You can now edit categories in the sidebar\n    - Assigning categories to feeds with recent activity can happen here\n  - You can now delete categories in the sidebar\n- Improves the experience of working with feeds\n  - Removes the dedicated feeds page\n  - You can now edit feeds in the sidebar [(#56)](https://github.com/hfellerhoff/serial/issues/56)\n    - Assigning categories now takes place here\n  - You can now delete feeds in the sidebar [(#56)](https://github.com/hfellerhoff/serial/issues/56)\n  - Feeds can now be searched through\n  - Relvant feeds are now clearly denoted at the top of the list\n- Adds PeerTube support [(#62)](https://github.com/hfellerhoff/serial/issues/62)\n\n#### Improvements\n\n- Adds the ability to go to a video's YouTube page from the watch page [(#55)](https://github.com/hfellerhoff/serial/issues/55)\n- Adds an initial data fetching loader element\n- Moves manual date and visibility filters into dropdowns (to make room for views)\n- Improves the onboarding experience a touch"
  },
  {
    "title": "Belated Spring Cleaning",
    "description": "A selection of quality of life updates!",
    "publish_date": "2025-06-07",
    "public": true,
    "_meta": {
      "filePath": "2025-06-07.md",
      "fileName": "2025-06-07.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-06-07"
    },
    "slug": "2025-06-07",
    "excerpt": "",
    "content": "#### Account Management\n\n- Users can now update their email\n- Users can now update their name\n- Users can now update their password from the app\n- Users can now delete their accounts\n\n#### Shortcuts\n\n- On small desktop screens, the right sidebar can now be toggled with `Shift` + `\\` or the `|` key (you can toggle the left with just `\\`)\n- You can now refresh feeds with `r`\n- Overhauls shortcuts to be more maintainable and easier to parse for developers\n\n#### Fixes\n\n- Fixes an issue where viewing a video from outside a user's feeds would crash the app"
  },
  {
    "title": "Article Support",
    "description": "Serial now supports adding generic RSS feeds, allowing you to add articles and blog posts to your views",
    "publish_date": "2025-08-28",
    "public": true,
    "_meta": {
      "filePath": "2025-08-28.md",
      "fileName": "2025-08-28.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-08-28"
    },
    "slug": "2025-08-28",
    "excerpt": "",
    "content": "## Features\n\n- Serial now supports generic RSS feeds, specifically geared towards including articles and blog posts\n- Serial now supports customizing the open location of each feed, letting you choose whether to open it in Serial or at the origin link\n  - This can be especially useful for articles and blog posts, where RSS feeds can often contain incomplete content\n\n## Improvements\n\n- Data is persisted locally between sessions, speeding startup times\n\n## Tweaks & Improvements (2025-08-31)\n\n- The \"Inbox\" time window is now \"One Month\"\n- Articles now include the `description` field for items (as a fallback for page content) if the RSS feed has it\n- Better support for Atom feeds\n- Article and Video zoom values are now separate"
  },
  {
    "title": "Unified Importing",
    "description": "Serial now supports one unified import UI, making it much easier and consistent to import data from YouTube and other RSS readers.",
    "publish_date": "2025-11-07",
    "public": true,
    "_meta": {
      "filePath": "2025-11-07.md",
      "fileName": "2025-11-07.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-11-07"
    },
    "slug": "2025-11-07",
    "excerpt": "",
    "content": "## Features\n\n- Update import view to be one, unified UI\n  - Upload `subscriptions.csv` and `*.opml` files in one interface\n  - More consistent & lenient imports\n  - See post-import success and error states on a per-feed basis\n\n## Improvements\n\n- Added inline shortcut display for feed refreshing (which is <kbd>r</kbd>)\n\n## Experimental\n\n- Added the ability to \"hold\" a video by holding <kbd>Space</kbd>, which is useful when you want to pause on a part of a video to read long text or look closer. Doing a full pause will cause the YouTube suggestions to pop up, so this is an attempt at a workaround. If you have feedback on this, don't hesitate to reach out!"
  },
  {
    "title": "Loaders & Feed Streaming",
    "description": "Serial's data fetching has been reworked, giving more clarity on loading statuses and feed errors.",
    "publish_date": "2025-11-25",
    "public": true,
    "_meta": {
      "filePath": "2025-11-25.md",
      "fileName": "2025-11-25.md",
      "directory": ".",
      "extension": "md",
      "path": "2025-11-25"
    },
    "slug": "2025-11-25",
    "excerpt": "",
    "content": "Happy early Thanksgiving! Here are some more architectural, quality-of-life changes to make Serial more stable and reliable:\n\n## Features\n\n- Reworked data fetching to stream feed item data, shortening the time before new data is available\n- Added feed statuses, making it easy to tell when a feed is broken or doesn't have content\n- Added top loading bar, which shows the progress on fetching feed data"
  },
  {
    "title": "Instapaper Integration",
    "description": "Serial now has Instapaper support, among many more behind-the-scenes improvements.",
    "publish_date": "2026-01-16",
    "public": true,
    "_meta": {
      "filePath": "2026-01-16.md",
      "fileName": "2026-01-16.md",
      "directory": ".",
      "extension": "md",
      "path": "2026-01-16"
    },
    "slug": "2026-01-16",
    "excerpt": "",
    "content": "## Features\n\n**Added support for [Instapaper](https://www.instapaper.com/)**\n  - Accounts can be connected under the \"Connections\" section of user settings\n  - Articles can be sent to Instapaper, which will attach the RSS item's content and mark the item as read\n\n## Improvements\n\n**Data fetching**\n  - Opening RSS items should feel snappier\n  - YouTube videos should load a little faster (specifically, lowering the time needed before you can play them)\n\n## Other notes\n\nSerial now uses Tanstack Start as a base framework instead of Next.js, which better reflects the more client-side identity of the app. This was holding up new feature work a little bit, so things should be much smoother sailing going forward."
  }
]