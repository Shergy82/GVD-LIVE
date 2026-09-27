import sqlite3
import os

db_path = os.path.join(os.path.dirname(__file__), 'database.sqlite')
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

tables = ['users', 'sessions', 'sites', 'site_customer_contacts', 'shifts', 'photos', 'pdfs', 'push_subscriptions']
for t in tables:
    try:
        cursor.execute(f"DELETE FROM {t}")
    except Exception as e:
        print(f"Error clearing {t}:", e)

cursor.execute("UPDATE id_sequences SET last_id = 0 WHERE name = 'site_id'")
cursor.execute("UPDATE settings SET app_name = 'GVD LIVE', logo_url = '' WHERE id = 1")

conn.commit()
conn.close()
print("DATABASE CLEANED SUCCESSFULLY! NO MOCK USERS REMAINING.")
