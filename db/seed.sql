-- Sample data for ReplyIQ (relative timestamps so deadlines are meaningful).
-- Staff users are seeded separately by scripts/seed-users.mjs (needs PBKDF2 hashing).
TRUNCATE drafts, messages, cases RESTART IDENTITY CASCADE;

INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
                   order_id, device_model, delivery_date, refund_issued, a_to_z_open, in_stock, approved_repair_price, tracking_number, carrier,
                   last_customer_message_at)
VALUES
-- Safety concern (priority, needs manager)
('RIQ-1001', 'Phone getting very hot while charging', 'open',
 'Emma', 'Thompson', 'emma.t@example.co.uk', '07700 900123', '14 Elm Road, Leeds LS1 4AB',
 '204-1234567-1234567', 'iPhone 13 128GB (Renewed)', CURRENT_DATE - 12, false, false, true, NULL, NULL, NULL,
 now() - INTERVAL '22 hours'),

-- INR, tracking shows delivered
('RIQ-1002', 'Order marked delivered but nothing arrived', 'open',
 'Oliver', 'Patel', 'oliver.p@example.co.uk', '07700 900456', '3 Castle Street, Bristol BS1 2AB',
 '203-9876543-7654321', 'Samsung Galaxy S22 (Renewed)', CURRENT_DATE - 2, false, false, true, NULL, 'EV123456789GB', 'Evri',
 now() - INTERVAL '5 hours'),

-- Battery complaint, 64 days (31-90 band)
('RIQ-1003', 'Battery drains in a few hours and shuts down at 20%', 'open',
 'Sophie', 'Williams', 'sophie.w@example.co.uk', NULL, '88 Queen Avenue, Manchester M1 1AA',
 '206-5555555-2222222', 'iPhone 12 64GB (Renewed)', CURRENT_DATE - 64, false, false, false, NULL, NULL, NULL,
 now() - INTERVAL '26 hours'),

-- Refund request, A-to-Z open (acknowledge only, manager)
('RIQ-1004', 'Still waiting for my refund', 'open',
 'James', 'O''Connor', 'james.oc@example.co.uk', '07700 900789', '21 Harbour Lane, Liverpool L1 8JQ',
 '205-1111111-3333333', 'Google Pixel 7 (Renewed)', CURRENT_DATE - 20, false, true, true, NULL, NULL, NULL,
 now() - INTERVAL '14 hours'),

-- Out-of-warranty repair with approved quote
('RIQ-1005', 'Cracked screen - can you repair it?', 'open',
 'Amelia', 'Hughes', 'amelia.h@example.co.uk', NULL, '7 Park View, Sheffield S1 2HE',
 '202-4444444-8888888', 'iPhone 14 Pro 256GB (Renewed)', CURRENT_DATE - 140, false, false, true, 89.00, NULL, NULL,
 now() - INTERVAL '2 hours'),

-- Missing accessory under £15
('RIQ-1006', 'No charging cable in the box', 'open',
 'Harry', 'Begum', 'harry.b@example.co.uk', '07700 900321', '55 Mill Road, Cambridge CB1 2AZ',
 '207-2222222-9999999', 'iPhone 15 128GB (Renewed)', CURRENT_DATE - 3, false, false, true, NULL, NULL, NULL,
 now() - INTERVAL '9 hours'),

-- eSIM / US variant
('RIQ-1007', 'No SIM tray on my iPhone?', 'open',
 'Isla', 'Murray', 'isla.m@example.co.uk', NULL, '12 Brae Street, Edinburgh EH1 1AA',
 '208-3333333-1111111', 'iPhone 14 128GB (Renewed, US model)', CURRENT_DATE - 1, false, false, false, NULL, NULL, NULL,
 now() - INTERVAL '1 hour'),

-- Resolved example
('RIQ-1008', 'Which charger do I need?', 'resolved',
 'Noah', 'Clarke', 'noah.c@example.co.uk', NULL, '9 Abbey Close, York YO1 7HH',
 '209-6666666-4444444', 'iPhone 15 Pro (Renewed)', CURRENT_DATE - 6, false, false, true, NULL, NULL, NULL,
 now() - INTERVAL '3 days');

INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES
(1, 'inbound', 'Customer', E'Hi,\n\nThe phone I bought from you gets really hot when it is charging, hot enough that I don''t want to hold it. Last night there was a faint burning smell near the port. It is only two weeks old. What should I do?\n\nEmma Thompson\n07700 900123', now() - INTERVAL '22 hours'),

(2, 'inbound', 'Customer', E'Hello, Amazon says my phone was delivered yesterday at 14:32 but nothing has arrived. I was home all day. Please help.', now() - INTERVAL '30 hours'),
(2, 'outbound', 'Saigates Support', E'Hi Oliver,\n\nThank you for letting us know. Evri has recorded the parcel as delivered yesterday afternoon. Could you check with anyone else in your household, your neighbours and any safe places such as a porch or bin store? If it still has not turned up, let us know and we will open an investigation with the carrier straight away.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '27 hours'),
(2, 'inbound', 'Customer', E'I have asked both neighbours and checked everywhere. Nothing. I want a refund or a replacement sent now please.', now() - INTERVAL '5 hours'),

(3, 'inbound', 'Customer', E'Hi, the battery on this iPhone is awful. It goes from full to about 20% in three or four hours of light use, then it just switches off. Battery health says 84%. It''s about two months old. What are my options?', now() - INTERVAL '26 hours'),

(4, 'inbound', 'Customer', E'I returned the Pixel on the 2nd and tracking shows you got it on the 5th. No refund yet so I have opened an A-to-Z claim with Amazon. Please sort this out today.', now() - INTERVAL '14 hours'),

(5, 'inbound', 'Customer', E'Hi, I dropped my phone and the screen is cracked. I know it''s my fault. Can you repair it and how much would it be?', now() - INTERVAL '4 days'),
(5, 'outbound', 'Saigates Support', E'Hi Amelia,\n\nSorry to hear that. We can certainly take a look. Please send the device back using the Amazon return process and our technicians will assess the damage. Once assessed we will let you know whether a repair is possible and what it would cost - there is no charge for the assessment.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '3 days 20 hours'),
(5, 'inbound', 'Customer', E'Great, it was delivered to you on Monday. Have you had a chance to look at it? What is the price?', now() - INTERVAL '2 hours'),

(6, 'inbound', 'Customer', E'The listing said a charging cable was included but there wasn''t one in the box. Can you send one?', now() - INTERVAL '9 hours'),

(7, 'inbound', 'Customer', E'I just got the iPhone 14 and there is no SIM card slot?! My EE SIM card won''t go in. Is this a fake? I need a working phone by the weekend.', now() - INTERVAL '1 hour'),

(8, 'inbound', 'Customer', E'Hi, does the iPhone 15 Pro use the old Lightning cable or USB-C? I want to order a spare.', now() - INTERVAL '3 days'),
(8, 'outbound', 'Saigates Support', E'Hi Noah,\n\nThe iPhone 15 Pro uses USB-C, so any good-quality USB-C cable will work for charging. Lightning cables are for the iPhone 14 and earlier.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '2 days 22 hours');
