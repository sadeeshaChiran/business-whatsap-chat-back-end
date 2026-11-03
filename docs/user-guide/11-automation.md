# Automation flows and forms

**Flows** send planned messages automatically – a welcome menu, an answer to a keyword, a reply to people who comment on your post. **Forms** collect details (name, address, requirement…) inside the chat or on a web page.

Open **AI & automation → Automation flows** or **Forms**.

## Flows

### When does it start (trigger)

| Trigger | Starts when… |
| --- | --- |
| **First message** | A new customer writes for the first time (optional: also when a customer comes back after N days). |
| **Keyword** | The message *contains*, *is exactly* or *starts with* one of your keywords (comma between them). |
| **Came from an ad** | The customer clicked one of your ads (enter the campaign IDs, or leave empty for any ad). |
| **Comment on a post** | Someone comments on your Facebook or Instagram post (optional keywords and a public reply under the comment). Meta allows one private message per comment, within 7 days. |

Choose the channels: WhatsApp, Messenger, Instagram. Ad flows run before keyword and first-message flows.

### Steps

Add up to 40 steps:

- **Message**, **Photo**, **Video** – use `{{name}}` for the customer's name.
- **Buttons** – up to 10 choices. WhatsApp shows 3 buttons; more become a list (button text up to 20 letters). If the customer types something else twice, the AI takes over.
- **Form** – ask a form in the chat, or send the form link.
- **Wait** – minutes, hours or days (up to 7 days).
- **Add tag**, **Lead stage**.
- **Hand over** – to the AI, or "My team answers" (the bot stops and you get a notification).
- **End** – the AI continues normally.

Buttons: **Save & turn on**, **Pause**, **Preview**, **Test it** (sends the flow to a test number – works even while the flow is off). The list shows how many runs started, are running now and finished.

> **Tip:** While a flow or form is talking to a customer, the AI bot waits. When the flow ends, the bot continues.

## Forms

**Forms → New form**:

- Up to 25 questions. Answer types: Short answer, Long answer, Phone number, Email, Number, Date, One choice, Several choices, Address, Photo.
- **Save to contact as** – put an answer into the contact's name, phone, email or address.
- Title, a short note at the top, the **thank-you message**, tags to add, and **Move the lead to** a stage.
- Every form has a **form page link** (`/f/your-form`) you can share anywhere – on Facebook, in your bio or as a QR code.

**Answers**: open a form → **Answers** to see every submission with the customer, date and source (WhatsApp, Messenger, Instagram or Form page). Search and download as CSV.

## How a form looks in the chat

Forms in the chat are short and clean. The customer gets **one question at a time**:

> 📝 **Order details** – 3 quick questions. Send **stop** any time to cancel.
>
> **1/3** Your name?
> *Tap your name or type it*

- The name and WhatsApp number we already know are offered as **tap buttons** (the number is shown as 07…), so the customer can answer with one tap.
- Choice questions show **buttons** (or a numbered list – the customer replies 1, 2, 3…).
- A wrong answer (for example an email without @) is asked again with ⚠️ and a short explanation.
- The customer can type **stop** (or cancel, exit, nevathanna, epa) to cancel. After 3 wrong answers your team takes over.
- At the end the customer gets a short summary of the answers and your thank-you message.
