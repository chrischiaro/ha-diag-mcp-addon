# ha-diag-mcp-addon

A diagnostic MCP for Home Assistant.

## Why?

Why even bother adding AI access to Home Assistant? Is it just to see if it can be done?

- _No_. We already know it can be done. There are other projects out there already.
- The motivation behind this was to get help diagnosing why automations were failing, or why certain devices were triggered unexpectedly.

### Real-world scenario

> _Claude, please take a look at my the automation I have to turn the Christmas tree on and off at certain times and tell me why it's not working._

That yielded:
> It's because you have it set to only happen between specific dates, and the start date happens _after_ the end date. Easiest solution: fix the start date.

To which I responded:

> Ok, except that I don't want to have to change the start and end dates each year. I want them to automatically work year after year. Can you modify the trigger code so that this happens.

...and Claude responded by providing an updated trigger do to just that!

Now, I certainly could have gone to the server, copied the YAML that controlled this automation, and pasted it for Claude to review. But why do that when (1) it's actually made up of three different parts (it includes helper variables to hold the start and end dates), and (2) this way I can just... well, _ask_!
