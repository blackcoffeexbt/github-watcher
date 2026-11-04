# Open your mailbox

1. Run **Set service password** in Actions and copy the generated password.
2. Open the **Web Interface** and sign in.
3. Select **Add repository**, enter a public GitHub URL or `owner/repo`, and choose release types and notification channels.

The newest matching release appears as New; earlier releases appear as Old. Opening a release marks it read. Use categories to group your projects and Search to find a release. Choose Light, Dark, or System appearance in Settings.

Checks run every three hours even while your browser is closed. The refresh button checks immediately. An optional GitHub token in Settings can help when following many repositories.

## Email notifications

Run **Configure SMTP** in Actions. Choose **System** to use your StartOS email settings, or **Custom** for another SMTP provider. Email is disabled initially. In the mailbox Settings, enable email, enter the recipient address, save, and send a test email. Check Recent deliveries for status or errors.

## Encrypted Nostr messages

In Settings, enable Nostr and enter the recipient npub. Messages use Anagram-compatible private DMs. Set App and discovery relays to the relays used in Anagram; published inbox relays are also included. Save and send a test DM. Settings also shows the service's sender npub; check message requests in your client if the test is not visible.

Use either notification channel or both. Each poll sends one summary per enabled channel, grouped by repository. Subscriptions can select which channels to use. Enabling notifications later does not send old release history. Changes to recipients apply to new jobs; queued jobs keep their original address and contents.

## Keep your data

StartOS backups include your subscriptions, read state, notification settings, sender identity, and pending deliveries. Keep backups private because they include credentials. To change the login password, run **Set service password** again. Existing sessions are signed out when the updated password is applied.

An Accepted delivery status means an email server or Nostr relay accepted the message. It does not guarantee the message reached your inbox. Failed deliveries can be retried from Settings. SMTP retries may occasionally produce duplicate messages.
