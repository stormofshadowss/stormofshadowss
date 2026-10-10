-- What kind of act a group is, so the shop's home page can offer filter chips (Boy bands / Girl groups / Solos / Duos). Optional: a group with none only shows under "All".
ALTER TABLE artist_groups ADD COLUMN kind VARCHAR(20) NULL;
