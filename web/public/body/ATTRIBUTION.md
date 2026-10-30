# The 3D anatomy model: where it comes from

`body.bin` and `body.json` are the muscles and the larger bones of **BodyParts3D 4.0**, © The Database Center for
Life Science (DBCLS), licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0).

- Database and licence: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/ (licence page:
  https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html)
- Licence text: https://creativecommons.org/licenses/by/4.0/
- Publication: Mitsuhashi N. et al. (2009), BodyParts3D: 3D structure database for anatomical concepts. Nucleic Acids
  Research 37, D782–D785. https://doi.org/10.1093/nar/gkn613

## Changes made to the original

1. By the Human Atlas project (https://github.com/ashemag/human-atlas), whose packed copy of BodyParts3D 4.0 these
   files were cut from: the meshes moved from millimetres with Z up to metres with Y up and placed on a common stage,
   simplified with meshoptimizer (a 0.2% relative error bound per structure), normals quantised to signed 16-bit, and
   the meshes packed into binary chunks.
2. For Serve: only the muscular system and the skeletal structures with at least 300 indices are kept (the tibialis
   anterior and the subscapularis, filed as skeletal in that copy, count as muscles); indices are stored as 16-bit
   wherever a part has fewer than 65,536 vertices; and each muscle is tagged, by its name, with the region of the body
   the app talks about (quadriceps, calves, lower back and so on).

The English structure names are BodyParts3D's own. BodyParts3D is an adult male reference anatomy; it is not a
complete model of every structure or of anyone in particular, and Serve's body view is not a clinical tool.

The app credits the model under the 3D view, with a link to the database.
