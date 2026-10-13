-- 0014 — Reply templates (ready-to-use short replies staff can insert into the draft editor) and knowledge-base seed
-- from the "UK Renewed Smartphone Customer Support Agent" brief. Additive; safe to re-run (seeds use ON CONFLICT / NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.reply_templates (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL DEFAULT 'general',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,                 -- may contain [Name], [Address], [date/time], [reference] placeholders
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_reply_templates_updated ON public.reply_templates;
CREATE TRIGGER trg_reply_templates_updated BEFORE UPDATE ON public.reply_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_reply_templates_no_delete ON public.reply_templates;
CREATE TRIGGER trg_reply_templates_no_delete BEFORE DELETE ON public.reply_templates FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();

INSERT INTO public.reply_templates (slug, category, title, body, sort_order) VALUES
('found-accessory', 'general', 'Customer found missing accessory',
E'Dear [Name],\n\nThank you for your message.\n\nNo problem at all, we\u2019re glad to hear you have now found it.\n\nIf you need any further help, please let us know.\n\nKind regards,\nCustomer Support Team', 10),
('return-proof-received', 'returns', 'Customer returned phone and sent proof',
E'Dear [Name],\n\nThank you for the update and for providing the postage receipt.\n\nWe have noted that the phone has now been returned. Once it arrives with us, our technicians will inspect the device and we will update you with the outcome.\n\nKind regards,\nCustomer Support Team', 20),
('replacement-address-confirmed', 'returns', 'Replacement address confirmed',
E'Dear [Name],\n\nThank you for confirming your details.\n\nWe have noted your return address as:\n\n[Address]\n\nWe will now proceed with arranging the replacement device. Once it has completed our final checks and is ready for dispatch, we will update you with the tracking details.\n\nKind regards,\nCustomer Support Team', 30),
('photos-requested', 'faults', 'Photos requested (six sides)',
E'Dear [Name],\n\nThank you for your message.\n\nWe\u2019re sorry to hear about the issue.\n\nPlease send clear photos of the phone from the front, back, left side, right side, top and bottom so we can review the device condition and advise the next steps.\n\nKind regards,\nCustomer Support Team', 40),
('photos-cannot-upload', 'faults', 'Photos cannot be uploaded',
E'Dear [Name],\n\nThank you for your message.\n\nNo problem. Please try sending the photos in separate messages, or send fewer photos at a time.\n\nOnce we receive them, we will review the device condition and advise the next steps.\n\nKind regards,\nCustomer Support Team', 50),
('return-instructions', 'returns', 'Return instructions (Royal Mail portal)',
E'Dear [Name],\n\nThank you for your message.\n\nPlease return the phone using our Royal Mail returns portal:\nhttps://www.royalmail.com/track-my-return#/details/7129\n\nBefore posting, please:\n- switch the phone off and remove the SIM card (and eSIM if possible)\n- back up and erase your personal data where possible\n- remove any PIN, passcode or screen lock\n- remove the Apple ID / iCloud account and turn off Find My\n- package the phone securely\n- keep your proof of postage or collection confirmation\n\nIf you cannot access the phone, you can remove it remotely by signing in at iCloud.com, selecting Find Devices, choosing the device, and selecting Remove from Account.\n\nOnce received, our technicians will inspect the device and we will update you with the outcome.\n\nKind regards,\nCustomer Support Team', 60),
('icloud-still-linked', 'returns', 'Returned device still linked to Apple ID',
E'Dear [Name],\n\nThank you for returning the phone.\n\nWe have received the device, but it is still linked to your Apple ID/iCloud account. Please remove it from your account so we can complete processing:\n\n1. Go to iCloud.com and sign in with your Apple ID\n2. Select Find Devices\n3. Choose the device\n4. Select Remove from Account\n\nFor data protection reasons, we cannot access your personal information or log in to the phone. If the phone has a passcode, your data cannot be accessed by us.\n\nOnce the device has been removed, please let us know and we will complete processing.\n\nKind regards,\nCustomer Support Team', 70),
('replacement-before-return', 'faults', 'Customer wants replacement before returning',
E'Dear [Name],\n\nThank you for your message.\n\nWe understand this is inconvenient, especially if this is your main phone. However, we are unable to send a replacement before receiving and inspecting the original device. The phone must be returned first so our technicians can verify the reported fault and check the overall condition.\n\nOnce received, if the fault is confirmed to be covered under the warranty, we will arrange the appropriate resolution as quickly as possible.\n\nIf you need any further help, please let us know.\n\nKind regards,\nCustomer Support Team', 80),
('inr-check-first', 'delivery', 'Item not received: tracking shows delivered',
E'Dear [Name],\n\nThank you for your message. We understand your concern.\n\nRoyal Mail tracking shows the parcel was delivered on [date/time]. Please could you check whether anyone at your address, a neighbour, reception/concierge or another household member may have accepted it, and whether it was left in a safe place?\n\nWe have also raised this with Royal Mail and will update you as soon as we receive their response.\n\nKind regards,\nCustomer Support Team', 90),
('inr-rm-confirmed', 'delivery', 'Royal Mail confirmed delivery to correct address',
E'Dear [Name],\n\nThank you for your patience while Royal Mail completed their investigation.\n\nRoyal Mail has confirmed that parcel [tracking] was delivered to the correct address, with proof of delivery recorded. As Royal Mail has not confirmed a loss or misdelivery, we are unable to issue a refund for this order.\n\nIf you believe the parcel was taken after delivery, we recommend continuing with your police report, and we will provide any information the police request.\n\nKind regards,\nCustomer Support Team', 100),
('out-of-warranty', 'faults', 'Out of warranty',
E'Dear [Name],\n\nThank you for your message. We\u2019re sorry to hear about the issue with your phone.\n\nWe have reviewed the order details and the 12-month warranty period has now expired. As the reported issue has been raised after the expiry of the warranty, we are unable to provide a free warranty repair, replacement or refund.\n\nIf you would like us to look at a paid repair, please let us know and we will advise the next steps.\n\nKind regards,\nCustomer Support Team', 110),
('sim-left-in-return', 'returns', 'SIM card left in returned phone',
E'Dear [Name],\n\nThank you for your message.\n\nWe have noted your request regarding the SIM card. Once we receive the returned device and it has been processed, we will remove the SIM card if it is still inside the phone and keep it safe for return to you.\n\nKind regards,\nCustomer Support Team', 120),
('dispatched-tracked24', 'delivery', 'Dispatched (reply to thank-you / review joke)',
E'Dear [Name],\n\nYou\u2019re very welcome. Your order has now been dispatched using Royal Mail Tracked 24.\n\nIf you need any further help, please let us know.\n\nKind regards,\nCustomer Support Team', 130)
ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

-- Knowledge base seed (active facts + rules the drafting model should know). Inserted only if a rule with the same title is absent.
INSERT INTO public.kb_rules (kind, category, title, rule_text, modes, status, sort_order, approved_at)
SELECT v.kind, v.category, v.title, v.rule_text, 'all', 'active', v.sort_order, now()
FROM (VALUES
  ('fact', 'products', 'Renewed device positioning', 'Devices are professionally inspected, tested, cleaned and functional before dispatch. Minor cosmetic signs of previous use may be present depending on the grade. Compatible accessories may be supplied; original Apple accessories and retail packaging are not guaranteed unless stated.', 10),
  ('fact', 'battery', 'Battery health within renewed standards', 'Battery health can vary within renewed standards. Health above the applicable minimum threshold is not automatically a fault. Never invent a battery health percentage.', 20),
  ('fact', 'battery', 'Unknown Part message', 'The Unknown Part notification can appear on refurbished iPhones where a component has been replaced during refurbishment. It does not mean the device is faulty. Offer inspection if there is a performance issue. Never call a part counterfeit.', 30),
  ('fact', 'returns', 'Royal Mail returns portal', 'Returns use our Royal Mail portal: https://www.royalmail.com/track-my-return#/details/7129 . Ask for secure packaging and proof of postage or collection confirmation.', 40),
  ('rule', 'returns', 'Return first, inspect, then decide', 'Whenever a resolution depends on the condition of the device, say that the phone must be returned first so our technicians can inspect it, and that the appropriate resolution (repair, replacement or refund) is confirmed after inspection. Never send a replacement before the original device has been received and inspected.', 50),
  ('rule', 'faults', 'Physical damage wording', 'For a bent frame, cracked back or lifting screen use neutral wording: physical damage can affect warranty eligibility as it may affect the structure and operation of the handset, and the cause cannot be confirmed from messages alone, which is why the device must be inspected. Third-party cases and accessories bought separately are not covered by the handset warranty.', 60),
  ('rule', 'faults', 'Repaired elsewhere before inspection', 'If the phone was repaired by a third party before we inspected it, say we are unable to verify the original condition of the device, the cause of the issue, or whether the fault would have been covered under the warranty.', 70),
  ('rule', 'delivery', 'Delivery disputes stay neutral', 'Quote only the Royal Mail tracking facts available in the case. Ask the customer to check household members, neighbours, a safe place, reception or concierge. Say we have raised it with Royal Mail. Never guarantee a refund before the investigation concludes. Never use the words theft or identity theft unless the customer or police raised them.', 80),
  ('rule', 'delivery', 'Royal Mail tracking is their data', 'Delivery updates come directly from Royal Mail; we can only see what their tracking system records. Delivery windows are an aim, not a guaranteed time. If access was unavailable Royal Mail usually retries the next working day and options can be changed on the Royal Mail tracking page.', 90),
  ('rule', 'refunds', 'Full refund expectation wording', 'If asked whether they will get a full refund: if the phone is returned in the same condition in which it was received, with no physical damage, all required accessories included and the Apple ID/iCloud account removed, we would expect to process a full refund in accordance with the applicable return policy. A deduction would only be considered if the device is returned damaged, missing accessories, or still linked to an Apple ID.', 100),
  ('rule', 'tone', 'Statutory wording only when needed', 'Use phrases like in line with Amazon policies and your statutory rights only for refund eligibility, return condition, warranty outcome, A-to-z, disputed delivery, out-of-warranty disputes or when the customer raises legal rights. Keep thank-yous, tracking updates, simple reassurance and general enquiries natural and free of policy wording.', 110),
  ('rule', 'tone', 'Convert internal notes to neutral wording', 'Internal notes such as looks like fraud, customer damaged it or being difficult must never be repeated. Convert them: Royal Mail has confirmed delivery with proof of delivery, signature and GPS location, so no loss or misdelivery has been confirmed; physical damage has been noted and may affect warranty eligibility; we understand this is frustrating and will do our best to assist within the return and warranty process.', 120),
  ('example', 'faults', 'Standard inspection sentence', 'Once received, our technicians will inspect the device. If the fault is confirmed to be covered under the warranty, we will arrange the appropriate resolution, which may include a repair, replacement or refund depending on the inspection outcome and availability.', 130),
  ('example', 'tone', 'Reply structure', 'Dear [first name], / Thank you for your message. / We are sorry to hear [issue]. We understand your concern. / [Clear response or seller position.] / [Next steps.] / [Conditional resolution if relevant.] / If you need any further help, please let us know. / Kind regards, Customer Support Team', 140)
) AS v(kind, category, title, rule_text, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.kb_rules k WHERE k.title = v.title);

-- Verification
SELECT 'table' AS kind, 'reply_templates' AS name WHERE to_regclass('public.reply_templates') IS NOT NULL
UNION ALL SELECT 'templates', COUNT(*)::text FROM public.reply_templates WHERE status = 'active'
UNION ALL SELECT 'kb_active_rules', COUNT(*)::text FROM public.kb_rules WHERE status = 'active';
