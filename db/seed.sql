-- Sample data for ReplyIQ (relative timestamps so deadlines are meaningful)
TRUNCATE drafts, messages, cases RESTART IDENTITY CASCADE;

INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
                   order_id, device_model, delivery_date, refund_issued, a_to_z_open, in_stock, approved_repair_price, tracking_number, carrier,
                   last_customer_message_at)
VALUES
('RIQ-1001', 'Item arrived damaged - screen cracked', 'open',
 'Emma', 'Thompson', 'emma.t@example.co.uk', '07700 900123', '14 Elm Road, Leeds LS1 4AB',
 '204-1234567-1234567', 'Saigates Tablet S10', CURRENT_DATE - 3, false, false, true, NULL, NULL, NULL,
 now() - INTERVAL '22 hours'),

('RIQ-1002', 'Where is my order? Tracking not updated', 'open',
 'Oliver', 'Patel', 'oliver.p@example.co.uk', '07700 900456', '3 Castle Street, Bristol BS1 2AB',
 '203-9876543-7654321', 'Saigates Earbuds Pro', NULL, false, false, true, NULL, 'EV123456789GB', 'Evri',
 now() - INTERVAL '5 hours'),

('RIQ-1003', 'Device stopped charging after 2 months', 'open',
 'Sophie', 'Williams', 'sophie.w@example.co.uk', NULL, '88 Queen Avenue, Manchester M1 1AA',
 '206-5555555-2222222', 'Saigates Smartwatch W3', CURRENT_DATE - 64, false, false, false, 25.00, NULL, NULL,
 now() - INTERVAL '26 hours'),

('RIQ-1004', 'Refund not received yet', 'open',
 'James', 'O''Connor', 'james.oc@example.co.uk', '07700 900789', '21 Harbour Lane, Liverpool L1 8JQ',
 '205-1111111-3333333', 'Saigates Bluetooth Speaker B2', CURRENT_DATE - 20, true, true, true, NULL, NULL, NULL,
 now() - INTERVAL '14 hours'),

('RIQ-1005', 'Wrong colour received', 'awaiting_customer',
 'Amelia', 'Hughes', 'amelia.h@example.co.uk', NULL, '7 Park View, Sheffield S1 2HE',
 '202-4444444-8888888', 'Saigates Power Bank P20', CURRENT_DATE - 2, false, false, true, NULL, 'RM987654321GB', 'Royal Mail',
 now() - INTERVAL '2 hours'),

('RIQ-1006', 'Missing charger cable in the box', 'resolved',
 'Harry', 'Begum', 'harry.b@example.co.uk', '07700 900321', '55 Mill Road, Cambridge CB1 2AZ',
 '207-2222222-9999999', 'Saigates Tablet S10', CURRENT_DATE - 9, false, false, true, NULL, NULL, NULL,
 now() - INTERVAL '3 days');

INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES
(1, 'inbound', 'Customer', E'Hi,\n\nMy tablet arrived today and the screen is cracked in the corner. The box looked fine so it must have happened before packing. I would like a replacement please.\n\nThanks,\nEmma Thompson', now() - INTERVAL '22 hours'),

(2, 'inbound', 'Customer', E'Hello, I ordered earbuds 6 days ago and the tracking has said "in transit" for 4 days with no update. Can you tell me what is going on?', now() - INTERVAL '30 hours'),
(2, 'outbound', 'Saigates Support', E'Hi Oliver,\n\nThank you for getting in touch. I have checked with Evri and the parcel is still moving through their network. I will chase them today and update you by tomorrow.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '27 hours'),
(2, 'inbound', 'Customer', E'Still nothing. If it is not here by Friday I want a refund. Please confirm.', now() - INTERVAL '5 hours'),

(3, 'inbound', 'Customer', E'Hi, my smartwatch stopped charging about a week ago. I have tried a different cable and cleaning the contacts. It is just over two months old. What are my options?', now() - INTERVAL '26 hours'),

(4, 'inbound', 'Customer', E'I returned the speaker on the 2nd and Amazon says it was received on the 5th. I still have not had my refund and I have opened an A-to-Z claim. Please sort this out.', now() - INTERVAL '14 hours'),

(5, 'inbound', 'Customer', E'I ordered the black power bank but received a silver one. Can you send the right one?', now() - INTERVAL '20 hours'),
(5, 'outbound', 'Saigates Support', E'Hi Amelia,\n\nSorry about that mix-up. We have dispatched the black power bank today via Royal Mail (RM987654321GB). You are welcome to keep the silver one as an apology.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '18 hours'),
(5, 'inbound', 'Customer', E'Brilliant, thank you so much!', now() - INTERVAL '2 hours'),

(6, 'inbound', 'Customer', E'The tablet came without the USB-C cable that is listed in the box contents. Can you send one?', now() - INTERVAL '3 days'),
(6, 'outbound', 'Saigates Support', E'Hi Harry,\n\nApologies for the missing cable. A replacement has been sent first class and should arrive within 2 working days.\n\nKind regards,\nSaigates Customer Care', now() - INTERVAL '2 days 20 hours');
