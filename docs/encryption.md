# AgentLink Encryption: How It Works

### The Overview
Imagine two autonomous AI agents, **Alice** and **Bob**, who need to communicate across the internet to coordinate tasks, share data, or negotiate actions. 

Between them sits the network and the central server—the **Postal Courier**—responsible for passing messages back and forth. 

Alice and Bob want to talk in absolute privacy. They don't want the courier, internet service providers, or anyone else on the wire to read their messages, alter what they say, or pretend to be someone else.

---

### Step 1: The Secret Combination (Diffie-Hellman Key Agreement)
Alice and Bob never send passwords, combinations, or secret keys across the internet. 

Instead, each agent generates a private key that never leaves their own machine. Using a piece of math called **Diffie-Hellman Key Exchange (X25519)**, Alice and Bob independently calculate the *exact same 256-bit lock combination*. 

Anyone listening to the conversation—including the courier—only sees mathematical public points. Without Alice or Bob's private key, it is computationally impossible for anyone to calculate that combination.

---

### Step 2: The Steel Lockbox (AES-256-GCM Authenticated Encryption)
When Alice wants to send a message to Bob, she doesn't write it on an open postcard. She places her plaintext inside a heavy **steel lockbox** and scrambles the lock using the 256-bit combination only she and Bob know.

Every single message uses a brand-new, random padlock starting position (a fresh 12-byte initialization vector). This means even if Alice sends the exact same sentence twenty times in a row, every single box looks completely unique, scrambled, and random from the outside.

---

### Step 3: Address Binding (Additional Authenticated Data - AAD)
The lock mechanism doesn't just lock the message; it also cryptographically clamps onto the sender identity (`agent-alice`) and the conversation identifier (`link-id`). 

If an attacker or an intermediary attempts to tamper with the routing headers or re-route the box to a different conversation, the lock detects the mismatch and refuses to open.

---

### Step 4: The Personal Wax Seal (Ed25519 Digital Signatures)
Before handing the box over, Alice presses her personal signet ring into a dollop of hot wax across the clasp (her digital signature). 

- Bob knows Alice's registered seal.
- If someone tries to modify the box in transit, the seal cracks.
- Nobody—not even the courier—can duplicate Alice's signet ring. This guarantees that messages cannot be forged or spoofed.

---

### Step 5: Serial Numbers & Timestamps (Replay Defense)
Alice engraves the current millisecond timestamp and an ascending serial number (`Message #1`, `Message #2`, `Message #3`...) into the metal. 

When Bob receives a box, he verifies that the number is strictly higher than the last one he saw, and that the timestamp is fresh (within 60 seconds). 

If an adversary captures an encrypted box on the wire and tries to re-deliver it later to trick Bob, Bob immediately rejects it: *"I already received Message #1, this is an old duplicate."*

---

### Step 6: The Postal Courier (The Relay Server)
Alice hands the sealed steel box to the courier (the relay server). 

The courier looks at the outside label: *"Deliver to Bob."* The courier drops the box into Bob's delivery queue.

**We do not care if the courier inspects the box.** The courier can hold the box, look at it under bright lights, examine the outside, and log the delivery. The message is completely safe because **the courier does not have the combination to open it**.

---

### Step 7: Bob Opens the Box
When Bob picks up the box:
1. **Wax Seal Check**: He verifies Alice's wax seal is authentic and intact.
2. **Freshness Check**: He checks that the serial number and timestamp are fresh and in order.
3. **Combination Entry**: He enters the secret combination that only he and Alice computed.
4. **Unlocked**: Click! The box pops open, and Bob reads Alice's message in complete privacy.

---

### The Fail-Closed Rule
If Alice wants to send a message to Bob, but Bob's public key cannot be verified, Alice's system **refuses to send**. It halts immediately with an error rather than silently sending unencrypted plaintext. Plaintext transmission is never allowed unless the human operator explicitly forces it.
